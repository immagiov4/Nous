import JSZip from 'jszip';
import type { ProjectExportData, ProjectSnapshot } from '../../types.ts';
import {
  loadZipSafely,
  readZipEntryBytesWithinLimit,
  readZipEntryTextWithinLimit,
} from '../../utils/project/zipSafety.ts';
import { isRecord } from '../../utils/records.ts';
import { createProjectArchiveBlob, readProjectImportData } from './projectArchive.ts';

const LIBRARY_ARCHIVE_FORMAT = 'nous-library-archive';
const LIBRARY_ARCHIVE_VERSION = 1;
const LIBRARY_ARCHIVE_EXTENSION = '.nous-library.zip';
const LIBRARY_ARCHIVE_MANIFEST_PATH = 'library.json';
const LIBRARY_ARCHIVE_PROJECTS_DIR = 'projects';
const LIBRARY_ARCHIVE_MIME_TYPE = 'application/zip';
const LIBRARY_ARCHIVE_MAX_ENTRIES = 1_002;
const LIBRARY_ARCHIVE_MAX_MANIFEST_BYTES = 1_000_000;
const LIBRARY_ARCHIVE_MAX_PROJECT_BYTES = 256_000_000;
const INVALID_LIBRARY_ARCHIVE_MESSAGE =
  "Questo ZIP non contiene un backup completo Nous valido. Importa un file .nous-library.zip esportato dall'app.";

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

interface LibraryArchiveProjectEntry {
  id: string;
  path: string;
  title: string;
}

interface LibraryArchiveManifest {
  archiveVersion: number;
  format: typeof LIBRARY_ARCHIVE_FORMAT;
  projects: LibraryArchiveProjectEntry[];
}

const sanitizeArchivePathSegment = (value: string): string => {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  return normalized || 'course';
};

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
    if (parsed.archiveVersion !== LIBRARY_ARCHIVE_VERSION) {
      throw new LibraryArchiveError(
        `La versione ${String(parsed.archiveVersion)} del backup non è supportata.`,
        'LIBRARY_ARCHIVE_VERSION_UNSUPPORTED',
        'manifest-read'
      );
    }
  }
  if (
    !isRecord(parsed) ||
    parsed.format !== LIBRARY_ARCHIVE_FORMAT ||
    parsed.archiveVersion !== LIBRARY_ARCHIVE_VERSION ||
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
      typeof project.title !== 'string' ||
      typeof project.path !== 'string' ||
      !project.path.startsWith(`${LIBRARY_ARCHIVE_PROJECTS_DIR}/`) ||
      !project.path.endsWith('.nous.zip')
    ) {
      throw new LibraryArchiveError(
        'Il manifest contiene una voce corso non valida.',
        'LIBRARY_ARCHIVE_INVALID',
        'manifest-read'
      );
    }
    return { id: project.id, path: project.path, title: project.title };
  });

  if (new Set(projects.map(project => project.path)).size !== projects.length) {
    throw new LibraryArchiveError(
      'Il manifest contiene più volte lo stesso archivio corso.',
      'LIBRARY_ARCHIVE_INVALID',
      'manifest-read'
    );
  }

  return {
    archiveVersion: LIBRARY_ARCHIVE_VERSION,
    format: LIBRARY_ARCHIVE_FORMAT,
    projects,
  };
};

export const createLibraryArchiveBlob = async (projects: ProjectSnapshot[]): Promise<Blob> => {
  if (projects.length === 0) {
    throw new Error('Non ci sono corsi da esportare.');
  }

  const zip = new JSZip();
  const manifestProjects: LibraryArchiveProjectEntry[] = [];

  for (const [index, project] of projects.entries()) {
    const title = project.learningPlan?.title || `Corso ${index + 1}`;
    const path = `${LIBRARY_ARCHIVE_PROJECTS_DIR}/${String(index + 1).padStart(3, '0')}-${sanitizeArchivePathSegment(project.id)}.nous.zip`;
    const projectArchive = await createProjectArchiveBlob(project);
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

export const readLibraryArchiveProjects = async (file: Blob): Promise<ProjectExportData[]> => {
  let zip: JSZip;
  try {
    zip = await loadZipSafely(new Uint8Array(await file.arrayBuffer()), {
      invalidArchiveMessage: INVALID_LIBRARY_ARCHIVE_MESSAGE,
      maxEntries: LIBRARY_ARCHIVE_MAX_ENTRIES,
    });
  } catch {
    throw new LibraryArchiveError(
      'Il file selezionato non è un archivio ZIP Nous leggibile.',
      'LIBRARY_ARCHIVE_ZIP_UNREADABLE',
      'zip-open'
    );
  }
  const manifest = await readManifest(zip);
  const projects: ProjectExportData[] = [];

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
      projects.push(
        (await readProjectImportData(new Blob([new Uint8Array(bytes)]))) as ProjectExportData
      );
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

  return projects;
};

export const getLibraryArchiveExtension = () => LIBRARY_ARCHIVE_EXTENSION;
