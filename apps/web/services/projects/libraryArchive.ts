import { buildOrderedSiblingItems } from '@shared/libraryOrdering';
import {
  loadZipSafely,
  readZipEntryBytesWithinLimit,
  readZipEntryTextWithinLimit,
} from '@shared/zipSafety';
import JSZip from 'jszip';
import type { LibraryFolder, LibraryPlacement, ProjectSnapshot } from '../../types.ts';
import { isRecord } from '../../utils/records.ts';
import { createProjectArchiveBlob, inspectProjectArchiveData } from './projectArchive.ts';
import type { ProjectRepository } from './projectRepository.ts';

const LIBRARY_ARCHIVE_FORMAT = 'nous-library-archive';
const LIBRARY_ARCHIVE_VERSION = 2;
const LIBRARY_ARCHIVE_EXTENSION = '.nous-library.zip';
const LIBRARY_ARCHIVE_MANIFEST_PATH = 'library.json';
const LIBRARY_ARCHIVE_PROJECTS_DIR = 'projects';
const LIBRARY_ARCHIVE_MIME_TYPE = 'application/zip';
const LIBRARY_ARCHIVE_MAX_ENTRIES = 1_002;
const LIBRARY_ARCHIVE_MAX_MANIFEST_BYTES = 1_000_000;
const LIBRARY_ARCHIVE_MAX_PROJECT_BYTES = 256_000_000;
const INVALID_LIBRARY_ARCHIVE_MESSAGE =
  "Questo ZIP non contiene un backup completo Nous valido. Importa un file .nous-library.zip esportato dall'app.";
const LIBRARY_PROJECT_PATH_PATTERN = /^projects\/[^/]+\.nous\.zip$/u;

export type LibraryArchiveErrorCode =
  | 'LIBRARY_ARCHIVE_ENTRY_MISSING'
  | 'LIBRARY_ARCHIVE_INVALID'
  | 'LIBRARY_ARCHIVE_PROJECT_INVALID'
  | 'LIBRARY_ARCHIVE_PROJECT_TOO_LARGE'
  | 'LIBRARY_ARCHIVE_SINGLE_PROJECT'
  | 'LIBRARY_ARCHIVE_VERSION_UNSUPPORTED'
  | 'LIBRARY_ARCHIVE_ZIP_UNREADABLE';

export type LibraryArchiveErrorStage = 'manifest-read' | 'nested-project-read' | 'zip-open';

export class LibraryArchiveError extends Error {
  constructor(
    message: string,
    readonly code: LibraryArchiveErrorCode,
    readonly stage: LibraryArchiveErrorStage,
    readonly projectIndex?: number,
    readonly projectCount?: number,
    readonly limitBytes?: number
  ) {
    super(message);
    this.name = 'LibraryArchiveError';
  }
}

export class LibraryArchiveRollbackError extends Error {
  constructor() {
    super(
      'L’importazione è stata interrotta, ma alcuni elementi potrebbero essere rimasti nella libreria.'
    );
    this.name = 'LibraryArchiveRollbackError';
  }
}

export interface LibraryArchiveProjectEntry {
  id: string;
  path: string;
  title: string;
}

interface LibraryArchiveManifest {
  archiveVersion: number;
  format: typeof LIBRARY_ARCHIVE_FORMAT;
  projects: LibraryArchiveProjectEntry[];
  folders: LibraryFolder[];
  placements: LibraryPlacement[];
}

const isValidTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));

const isValidOrder = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export interface LibraryArchiveData {
  projects: LibraryArchiveProjectEntry[];
  projectArchives: Array<{ archive: Blob; id: string }>;
  folders: LibraryFolder[];
  placements: LibraryPlacement[];
}

export interface LibraryArchiveOrganization {
  folders: LibraryFolder[];
  placements: LibraryPlacement[];
}

const sanitizeArchivePathSegment = (value: string): string => {
  const normalized = value.trim().replaceAll(/[^a-zA-Z0-9._-]+/g, '_');
  return normalized || 'course';
};

const formatArchiveVersion = (value: unknown): string =>
  typeof value === 'number' || typeof value === 'string' ? String(value) : 'sconosciuta';

const readManifest = async (zip: JSZip): Promise<LibraryArchiveManifest> => {
  const manifestEntry = zip.file(LIBRARY_ARCHIVE_MANIFEST_PATH);
  if (!manifestEntry) {
    if (zip.file('project.json')) {
      throw new LibraryArchiveError(
        'Hai selezionato il backup di un singolo corso. Qui serve il backup completo della libreria.',
        'LIBRARY_ARCHIVE_SINGLE_PROJECT',
        'manifest-read'
      );
    }
    throw new LibraryArchiveError(
      'Nel backup manca il file library.json.',
      'LIBRARY_ARCHIVE_INVALID',
      'manifest-read'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readZipEntryTextWithinLimit(
        manifestEntry,
        LIBRARY_ARCHIVE_MAX_MANIFEST_BYTES,
        `Il manifest del backup supera il limite di ${LIBRARY_ARCHIVE_MAX_MANIFEST_BYTES} byte.`
      )
    ) as unknown;
  } catch (error) {
    if (error instanceof LibraryArchiveError) throw error;
    throw new LibraryArchiveError(
      'Il manifest library.json non è leggibile.',
      'LIBRARY_ARCHIVE_INVALID',
      'manifest-read'
    );
  }
  if (isRecord(parsed) && parsed.format === LIBRARY_ARCHIVE_FORMAT) {
    if (parsed.archiveVersion !== 1 && parsed.archiveVersion !== LIBRARY_ARCHIVE_VERSION) {
      throw new LibraryArchiveError(
        `La versione ${formatArchiveVersion(parsed.archiveVersion)} del backup non è supportata.`,
        'LIBRARY_ARCHIVE_VERSION_UNSUPPORTED',
        'manifest-read'
      );
    }
  }
  if (
    !isRecord(parsed) ||
    parsed.format !== LIBRARY_ARCHIVE_FORMAT ||
    (parsed.archiveVersion !== 1 && parsed.archiveVersion !== LIBRARY_ARCHIVE_VERSION) ||
    !Array.isArray(parsed.projects) ||
    parsed.projects.length === 0
  ) {
    throw new LibraryArchiveError(
      INVALID_LIBRARY_ARCHIVE_MESSAGE,
      'LIBRARY_ARCHIVE_INVALID',
      'manifest-read'
    );
  }

  const projects = parsed.projects.map(project => {
    if (
      !isRecord(project) ||
      typeof project.id !== 'string' ||
      !project.id.trim() ||
      typeof project.title !== 'string' ||
      !project.title.trim() ||
      typeof project.path !== 'string' ||
      !LIBRARY_PROJECT_PATH_PATTERN.test(project.path)
    ) {
      throw new LibraryArchiveError(
        'Il manifest contiene una voce corso non valida.',
        'LIBRARY_ARCHIVE_INVALID',
        'manifest-read'
      );
    }
    return { id: project.id, path: project.path, title: project.title };
  });

  if (
    new Set(projects.map(project => project.path)).size !== projects.length ||
    new Set(projects.map(project => project.id)).size !== projects.length
  ) {
    throw new LibraryArchiveError(
      'Il manifest contiene più volte lo stesso archivio corso.',
      'LIBRARY_ARCHIVE_INVALID',
      'manifest-read'
    );
  }

  let folders: LibraryFolder[] = [];
  let placements: LibraryPlacement[] = [];
  if (parsed.archiveVersion === LIBRARY_ARCHIVE_VERSION) {
    if (!Array.isArray(parsed.folders) || !Array.isArray(parsed.placements)) {
      throw new LibraryArchiveError(
        'Nel backup manca la struttura delle cartelle.',
        'LIBRARY_ARCHIVE_INVALID',
        'manifest-read'
      );
    }
    folders = parsed.folders.map(folder => {
      if (
        !isRecord(folder) ||
        typeof folder.id !== 'string' ||
        !folder.id.trim() ||
        typeof folder.name !== 'string' ||
        !folder.name.trim() ||
        (folder.parentFolderId !== null &&
          (typeof folder.parentFolderId !== 'string' || !folder.parentFolderId.trim())) ||
        !isValidTimestamp(folder.createdAt) ||
        !isValidTimestamp(folder.updatedAt) ||
        !isValidOrder(folder.order)
      ) {
        throw new LibraryArchiveError(
          'Il manifest contiene una cartella non valida.',
          'LIBRARY_ARCHIVE_INVALID',
          'manifest-read'
        );
      }
      return {
        id: folder.id,
        name: folder.name,
        parentFolderId: folder.parentFolderId,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
        order: folder.order,
      };
    });
    placements = parsed.placements.map(placement => {
      if (
        !isRecord(placement) ||
        typeof placement.projectId !== 'string' ||
        !placement.projectId.trim() ||
        (placement.folderId !== null &&
          (typeof placement.folderId !== 'string' || !placement.folderId.trim())) ||
        !isValidTimestamp(placement.updatedAt) ||
        !isValidOrder(placement.order)
      ) {
        throw new LibraryArchiveError(
          'Il manifest contiene un posizionamento non valido.',
          'LIBRARY_ARCHIVE_INVALID',
          'manifest-read'
        );
      }
      return {
        projectId: placement.projectId,
        folderId: placement.folderId,
        updatedAt: placement.updatedAt,
        order: placement.order,
      };
    });

    const folderIds = new Set(folders.map(folder => folder.id));
    const projectIds = new Set(projects.map(project => project.id));
    if (
      folderIds.size !== folders.length ||
      new Set(placements.map(placement => placement.projectId)).size !== placements.length ||
      placements.length !== projects.length ||
      folders.some(
        folder => folder.parentFolderId !== null && !folderIds.has(folder.parentFolderId)
      ) ||
      placements.some(
        placement =>
          !projectIds.has(placement.projectId) ||
          (placement.folderId !== null && !folderIds.has(placement.folderId))
      )
    ) {
      throw new LibraryArchiveError(
        'La struttura delle cartelle nel backup non è coerente.',
        'LIBRARY_ARCHIVE_INVALID',
        'manifest-read'
      );
    }

    const folderById = new Map(folders.map(folder => [folder.id, folder]));
    for (const folder of folders) {
      const visited = new Set<string>();
      let current: LibraryFolder | undefined = folder;
      while (current?.parentFolderId) {
        if (visited.has(current.id)) {
          throw new LibraryArchiveError(
            'La gerarchia delle cartelle nel backup contiene un ciclo.',
            'LIBRARY_ARCHIVE_INVALID',
            'manifest-read'
          );
        }
        visited.add(current.id);
        current = folderById.get(current.parentFolderId);
      }
    }
  }

  return {
    archiveVersion: parsed.archiveVersion,
    format: LIBRARY_ARCHIVE_FORMAT,
    projects,
    folders,
    placements,
  };
};

export const createLibraryArchiveBlob = async (
  projects: ProjectSnapshot[],
  organization: LibraryArchiveOrganization,
  options: {
    createProjectArchive?: (project: ProjectSnapshot) => Promise<Blob>;
  } = {}
): Promise<Blob> => {
  if (projects.length === 0) {
    throw new Error('Non ci sono corsi da esportare.');
  }
  const projectIds = new Set(projects.map(project => project.id));
  const placementProjectIds = new Set(
    organization.placements.map(placement => placement.projectId)
  );
  if (
    projectIds.size !== projects.length ||
    placementProjectIds.size !== organization.placements.length ||
    placementProjectIds.size !== projectIds.size ||
    [...projectIds].some(projectId => !placementProjectIds.has(projectId))
  ) {
    throw new Error('La struttura della libreria non contiene un posizionamento per ogni corso.');
  }

  const zip = new JSZip();
  const manifestProjects: LibraryArchiveProjectEntry[] = [];

  for (const [index, project] of projects.entries()) {
    const title = project.learningPlan?.title || `Corso ${index + 1}`;
    const path = `${LIBRARY_ARCHIVE_PROJECTS_DIR}/${String(index + 1).padStart(3, '0')}-${sanitizeArchivePathSegment(project.id)}.nous.zip`;
    const projectArchive = options.createProjectArchive
      ? await options.createProjectArchive(project)
      : await createProjectArchiveBlob(project);
    zip.file(path, new Uint8Array(await projectArchive.arrayBuffer()), {
      binary: true,
      compression: 'STORE',
    });
    manifestProjects.push({ id: project.id, path, title });
  }

  const manifest: LibraryArchiveManifest = {
    archiveVersion: LIBRARY_ARCHIVE_VERSION,
    format: LIBRARY_ARCHIVE_FORMAT,
    projects: manifestProjects,
    folders: organization.folders,
    placements: organization.placements,
  };
  zip.file(LIBRARY_ARCHIVE_MANIFEST_PATH, JSON.stringify(manifest), {
    compression: 'DEFLATE',
  });

  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  return new Blob([new Uint8Array(bytes)], { type: LIBRARY_ARCHIVE_MIME_TYPE });
};

export const readLibraryArchive = async (file: Blob): Promise<LibraryArchiveData> => {
  let zip: JSZip;
  try {
    // Nested project archives are stored verbatim; only library.json may expand materially.
    zip = await loadZipSafely(new Uint8Array(await file.arrayBuffer()), {
      invalidArchiveMessage: INVALID_LIBRARY_ARCHIVE_MESSAGE,
      maxEntries: LIBRARY_ARCHIVE_MAX_ENTRIES,
      maxTotalUncompressedBytes: file.size + LIBRARY_ARCHIVE_MAX_MANIFEST_BYTES,
    });
  } catch {
    throw new LibraryArchiveError(
      'Il file selezionato non è un archivio ZIP Nous leggibile.',
      'LIBRARY_ARCHIVE_ZIP_UNREADABLE',
      'zip-open'
    );
  }
  const manifest = await readManifest(zip);
  const projects: LibraryArchiveProjectEntry[] = [];
  const projectArchives: Array<{ archive: Blob; id: string }> = [];

  for (const [index, project] of manifest.projects.entries()) {
    const projectIndex = index + 1;
    const projectCount = manifest.projects.length;
    const entry = zip.file(project.path);
    if (!entry) {
      throw new LibraryArchiveError(
        `Nel backup manca il corso ${projectIndex} di ${projectCount}.`,
        'LIBRARY_ARCHIVE_ENTRY_MISSING',
        'nested-project-read',
        projectIndex,
        projectCount
      );
    }

    try {
      const bytes = await readZipEntryBytesWithinLimit(
        entry,
        LIBRARY_ARCHIVE_MAX_PROJECT_BYTES,
        `Il corso ${projectIndex} di ${projectCount} supera il limite di ${LIBRARY_ARCHIVE_MAX_PROJECT_BYTES} byte.`
      );
      const projectArchive = new Blob([Uint8Array.from(bytes).buffer]);
      const importedProject = await inspectProjectArchiveData(projectArchive);
      if (importedProject.id !== project.id) {
        throw new LibraryArchiveError(
          `Il corso ${projectIndex} di ${projectCount} non corrisponde al manifest.`,
          'LIBRARY_ARCHIVE_PROJECT_INVALID',
          'nested-project-read',
          projectIndex,
          projectCount
        );
      }
      projects.push(project);
      projectArchives.push({ archive: projectArchive, id: project.id });
    } catch (error) {
      const tooLarge = error instanceof Error && error.message.includes('limite');
      throw new LibraryArchiveError(
        tooLarge
          ? error.message
          : `Il corso ${projectIndex} di ${projectCount} contiene un archivio non valido o non supportato.`,
        tooLarge ? 'LIBRARY_ARCHIVE_PROJECT_TOO_LARGE' : 'LIBRARY_ARCHIVE_PROJECT_INVALID',
        'nested-project-read',
        projectIndex,
        projectCount,
        tooLarge ? LIBRARY_ARCHIVE_MAX_PROJECT_BYTES : undefined
      );
    }
  }

  return {
    projects,
    projectArchives,
    folders: manifest.folders,
    placements: manifest.placements,
  };
};

type LibraryOrganizationRepository = Pick<
  ProjectRepository,
  'createFolder' | 'deleteFolder' | 'moveFolder' | 'moveProjects'
>;

export const restoreLibraryArchiveOrganization = async (
  repository: LibraryOrganizationRepository,
  organization: LibraryArchiveOrganization,
  projectIdMap: ReadonlyMap<string, string> = new Map()
): Promise<void> => {
  const folderIdMap = new Map<string, string>();
  const createdFolderIds: string[] = [];
  const pendingFolders = organization.folders
    .slice()
    .sort((left, right) => left.order - right.order);

  try {
    while (pendingFolders.length > 0) {
      const readyIndex = pendingFolders.findIndex(
        folder => folder.parentFolderId === null || folderIdMap.has(folder.parentFolderId)
      );
      if (readyIndex < 0) {
        throw new LibraryArchiveError(
          'La gerarchia delle cartelle nel backup contiene un ciclo.',
          'LIBRARY_ARCHIVE_INVALID',
          'manifest-read'
        );
      }
      const [folder] = pendingFolders.splice(readyIndex, 1);
      if (!folder) continue;
      const parentFolderId =
        folder.parentFolderId === null ? null : folderIdMap.get(folder.parentFolderId) || null;
      const created = await repository.createFolder({ name: folder.name, parentFolderId });
      folderIdMap.set(folder.id, created.id);
      createdFolderIds.push(created.id);
    }

    const parentIds: Array<string | null> = [
      null,
      ...organization.folders.map(folder => folder.id),
    ];
    for (const parentId of parentIds) {
      const siblings = buildOrderedSiblingItems(
        organization.folders,
        organization.placements,
        parentId
      );

      for (const [targetIndex, sibling] of siblings.entries()) {
        const mappedParentId = parentId === null ? null : folderIdMap.get(parentId) || null;
        if (sibling.kind === 'folder') {
          const folderId = folderIdMap.get(sibling.value.id);
          if (folderId) await repository.moveFolder(folderId, mappedParentId, targetIndex);
        } else {
          const projectId = projectIdMap.get(sibling.value.projectId);
          if (!projectId) {
            throw new LibraryArchiveError(
              'Il backup contiene un corso senza corrispondenza durante il ripristino.',
              'LIBRARY_ARCHIVE_INVALID',
              'manifest-read'
            );
          }
          await repository.moveProjects([projectId], mappedParentId, targetIndex);
        }
      }
    }
  } catch (error) {
    let rollbackFailed = false;
    const rollbackFolderIds = [...createdFolderIds].reverse();
    for (const folderId of rollbackFolderIds) {
      try {
        await repository.deleteFolder(folderId);
      } catch (cleanupError) {
        rollbackFailed = true;
        console.warn('[Nous] Failed to roll back an imported library folder.', cleanupError);
      }
    }
    if (rollbackFailed) throw new LibraryArchiveRollbackError();
    throw error;
  }
};

export const getLibraryArchiveExtension = () => LIBRARY_ARCHIVE_EXTENSION;
