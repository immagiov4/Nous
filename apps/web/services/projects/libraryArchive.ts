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
    throw new Error(INVALID_LIBRARY_ARCHIVE_MESSAGE);
  }

  const parsed = JSON.parse(
    await readZipEntryTextWithinLimit(
      manifestEntry,
      LIBRARY_ARCHIVE_MAX_MANIFEST_BYTES,
      INVALID_LIBRARY_ARCHIVE_MESSAGE
    )
  ) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.format !== LIBRARY_ARCHIVE_FORMAT ||
    parsed.archiveVersion !== LIBRARY_ARCHIVE_VERSION ||
    !Array.isArray(parsed.projects) ||
    parsed.projects.length === 0
  ) {
    throw new Error(INVALID_LIBRARY_ARCHIVE_MESSAGE);
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
      throw new Error(INVALID_LIBRARY_ARCHIVE_MESSAGE);
    }
    return { id: project.id, path: project.path, title: project.title };
  });

  if (new Set(projects.map(project => project.path)).size !== projects.length) {
    throw new Error(INVALID_LIBRARY_ARCHIVE_MESSAGE);
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
  const zip = await loadZipSafely(new Uint8Array(await file.arrayBuffer()), {
    invalidArchiveMessage: INVALID_LIBRARY_ARCHIVE_MESSAGE,
    maxEntries: LIBRARY_ARCHIVE_MAX_ENTRIES,
  });
  const manifest = await readManifest(zip);

  return Promise.all(
    manifest.projects.map(async project => {
      const entry = zip.file(project.path);
      if (!entry) {
        throw new Error(INVALID_LIBRARY_ARCHIVE_MESSAGE);
      }
      const bytes = await readZipEntryBytesWithinLimit(
        entry,
        LIBRARY_ARCHIVE_MAX_PROJECT_BYTES,
        INVALID_LIBRARY_ARCHIVE_MESSAGE
      );
      return (await readProjectImportData(new Blob([new Uint8Array(bytes)]))) as ProjectExportData;
    })
  );
};

export const getLibraryArchiveExtension = () => LIBRARY_ARCHIVE_EXTENSION;
