import JSZip from 'jszip';
import type { FileData, ProjectExportData, ProjectSnapshot } from '../../types.ts';
import {
  loadZipSafely,
  readZipEntryBytesWithinLimit,
  readZipEntryTextWithinLimit,
} from '../../utils/project/zipSafety.ts';
import { isRecord } from '../../utils/records.ts';
import { exportProjectData } from './projectSnapshot.ts';
import { decodeBase64Bytes, encodeBytesBase64 } from './projectSource.ts';

const PROJECT_ARCHIVE_FORMAT = 'nous-project-archive';
const LEGACY_PROJECT_ARCHIVE_FORMAT = 'lumina-project-archive';
const PROJECT_ARCHIVE_VERSION = 1;
const PROJECT_ARCHIVE_MIME_TYPE = 'application/zip';
const PROJECT_ARCHIVE_MANIFEST_PATH = 'project.json';
const PROJECT_ARCHIVE_SOURCE_DIR = 'source';
const INVALID_BACKUP_ARCHIVE_MESSAGE =
  "Questo ZIP non contiene un backup Nous valido. Importa un file .nous.zip esportato dall'app.";
const INVALID_BACKUP_FILE_MESSAGE = 'Il file selezionato non e un backup Nous valido.';
const PROJECT_ARCHIVE_MAX_ENTRIES = 128;
const PROJECT_ARCHIVE_MAX_MANIFEST_BYTES = 20_000_000;
const PROJECT_ARCHIVE_MAX_ATTACHMENT_BYTES = 80_000_000;

interface ProjectArchiveAttachment {
  mimeType: string;
  name: string;
  path: string;
  sourceId?: string;
}

interface ProjectArchiveManifest {
  archiveVersion: number;
  attachments?: {
    sourceFile?: ProjectArchiveAttachment;
    sourceFiles?: ProjectArchiveAttachment[];
  };
  format: typeof PROJECT_ARCHIVE_FORMAT | typeof LEGACY_PROJECT_ARCHIVE_FORMAT;
  project: Omit<ProjectExportData, 'file' | 'source'> & {
    source?: ProjectExportData['source'];
  };
}

interface LoadedProjectArchive {
  manifest: ProjectArchiveManifest;
  zip: JSZip;
}

const sanitizeArchivePathSegment = (value: string): string => {
  const withoutControlCharacters = Array.from(value.trim(), char =>
    char <= '\u001f' ? '_' : char
  ).join('');
  const normalized = withoutControlCharacters.replace(/[<>:"/\\|?*]/g, '_');
  return normalized || 'source';
};

const isZipArchive = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
  (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);

const isProjectImportPayload = (value: unknown): value is ProjectExportData =>
  isRecord(value) &&
  typeof value.version === 'string' &&
  typeof value.isLearnMode === 'boolean' &&
  Array.isArray(value.syllabus) &&
  Object.hasOwn(value, 'learningPlan');

function assertProjectImportPayload(
  value: unknown,
  invalidMessage = INVALID_BACKUP_FILE_MESSAGE
): asserts value is ProjectExportData {
  if (!isProjectImportPayload(value)) {
    throw new Error(invalidMessage);
  }
}

const buildArchiveManifest = (
  snapshot: ProjectSnapshot
): {
  attachments?: Array<{ bytes: Uint8Array; entry: ProjectArchiveAttachment }>;
  manifest: ProjectArchiveManifest;
} => {
  const project = exportProjectData(snapshot);
  const { file: _legacyFile, source: projectSource, ...projectRest } = project;

  if (snapshot.source?.sources?.length) {
    const attachments = snapshot.source.sources
      .filter(source => source.file.data)
      .map((source, index) => ({
        bytes: decodeBase64Bytes(source.file.data),
        entry: {
          path: `${PROJECT_ARCHIVE_SOURCE_DIR}/${String(index + 1).padStart(3, '0')}-${sanitizeArchivePathSegment(source.file.name)}`,
          name: source.file.name,
          mimeType: source.file.mimeType,
          sourceId: source.id,
        },
      }));
    const archivedSources = snapshot.source.sources.map(source => ({
      ...source,
      file: { ...source.file, data: '' },
    }));
    let archivedSource: ProjectExportData['source'];
    if (snapshot.source.kind === 'pdf') {
      const { ref: _serverSourceReference, ...portableSource } = snapshot.source;
      archivedSource = {
        ...portableSource,
        file: { ...snapshot.source.file, data: '' },
        sources: archivedSources,
      };
    } else {
      archivedSource = { ...snapshot.source, sources: archivedSources };
    }

    return {
      attachments,
      manifest: {
        format: PROJECT_ARCHIVE_FORMAT,
        archiveVersion: PROJECT_ARCHIVE_VERSION,
        attachments: { sourceFiles: attachments.map(attachment => attachment.entry) },
        project: { ...projectRest, source: archivedSource },
      },
    };
  }

  if (snapshot.source?.kind !== 'pdf') {
    return {
      manifest: {
        format: PROJECT_ARCHIVE_FORMAT,
        archiveVersion: PROJECT_ARCHIVE_VERSION,
        project: {
          ...projectRest,
          source: projectSource || null,
        },
      },
    };
  }

  const file = snapshot.source.file;
  const archivePath = `${PROJECT_ARCHIVE_SOURCE_DIR}/${sanitizeArchivePathSegment(file.name)}`;

  return {
    attachments: [
      {
        bytes: decodeBase64Bytes(file.data),
        entry: {
          path: archivePath,
          name: file.name,
          mimeType: file.mimeType,
        },
      },
    ],
    manifest: {
      format: PROJECT_ARCHIVE_FORMAT,
      archiveVersion: PROJECT_ARCHIVE_VERSION,
      attachments: {
        sourceFile: {
          path: archivePath,
          name: file.name,
          mimeType: file.mimeType,
        },
      },
      project: {
        ...projectRest,
        source: {
          kind: 'pdf',
          file: {
            name: file.name,
            mimeType: file.mimeType,
          } as FileData,
        },
      },
    },
  };
};

const loadProjectArchive = async (bytes: Uint8Array): Promise<LoadedProjectArchive> => {
  const zip = await loadZipSafely(bytes, {
    invalidArchiveMessage: INVALID_BACKUP_ARCHIVE_MESSAGE,
    maxEntries: PROJECT_ARCHIVE_MAX_ENTRIES,
  });
  const manifestEntry = zip.file(PROJECT_ARCHIVE_MANIFEST_PATH);

  if (!manifestEntry) {
    throw new Error(INVALID_BACKUP_ARCHIVE_MESSAGE);
  }

  const manifest = JSON.parse(
    await readZipEntryTextWithinLimit(
      manifestEntry,
      PROJECT_ARCHIVE_MAX_MANIFEST_BYTES,
      INVALID_BACKUP_ARCHIVE_MESSAGE
    )
  ) as ProjectArchiveManifest;

  if (
    manifest.format !== PROJECT_ARCHIVE_FORMAT &&
    manifest.format !== LEGACY_PROJECT_ARCHIVE_FORMAT
  ) {
    throw new Error(INVALID_BACKUP_ARCHIVE_MESSAGE);
  }

  if (!manifest.project || typeof manifest.project !== 'object') {
    throw new Error('Archivio backup non valido: manifest incompleto.');
  }

  assertProjectImportPayload(manifest.project, INVALID_BACKUP_ARCHIVE_MESSAGE);

  return { manifest, zip };
};

const decodeArchiveManifest = async (bytes: Uint8Array): Promise<ProjectExportData> => {
  const { manifest, zip } = await loadProjectArchive(bytes);

  if (manifest.attachments?.sourceFiles?.length && manifest.project.source?.sources?.length) {
    const filesBySourceId = new Map(
      await Promise.all(
        manifest.attachments.sourceFiles.map(async attachment => {
          const attachmentEntry = zip.file(attachment.path);
          if (!attachmentEntry || !attachment.sourceId) {
            throw new Error(`Archivio backup non valido: manca ${attachment.path}.`);
          }
          const fileBytes = await readZipEntryBytesWithinLimit(
            attachmentEntry,
            PROJECT_ARCHIVE_MAX_ATTACHMENT_BYTES,
            INVALID_BACKUP_ARCHIVE_MESSAGE
          );
          return [
            attachment.sourceId,
            {
              name: attachment.name,
              mimeType: attachment.mimeType,
              data: encodeBytesBase64(fileBytes),
              sourceId: attachment.sourceId,
            } satisfies FileData,
          ] as const;
        })
      )
    );
    const sources = manifest.project.source.sources.map(source => ({
      ...source,
      file: filesBySourceId.get(source.id) || source.file,
    }));
    const primarySourceId =
      manifest.project.source.kind === 'pdf' ? manifest.project.source.file.sourceId : undefined;
    const primaryFile =
      sources.find(source => source.id === primarySourceId)?.file || sources[0]?.file;
    return {
      ...manifest.project,
      source:
        manifest.project.source.kind === 'pdf' && primaryFile
          ? { ...manifest.project.source, file: primaryFile, sources }
          : { ...manifest.project.source, sources },
    };
  }

  if (manifest.attachments?.sourceFile && manifest.project.source?.kind === 'pdf') {
    const attachment = manifest.attachments.sourceFile;
    const attachmentEntry = zip.file(attachment.path);

    if (!attachmentEntry) {
      throw new Error(`Archivio backup non valido: manca ${attachment.path}.`);
    }

    const fileBytes = await readZipEntryBytesWithinLimit(
      attachmentEntry,
      PROJECT_ARCHIVE_MAX_ATTACHMENT_BYTES,
      INVALID_BACKUP_ARCHIVE_MESSAGE
    );

    return {
      ...manifest.project,
      source: {
        kind: 'pdf',
        file: {
          name: attachment.name,
          mimeType: attachment.mimeType,
          data: encodeBytesBase64(fileBytes),
        },
      },
    };
  }

  const source = manifest.project.source;

  if (source?.kind === 'pdf') {
    throw new Error('Archivio backup non valido: allegato PDF mancante.');
  }

  return {
    ...manifest.project,
    source: source || null,
  };
};

export const isProjectArchiveFile = async (file: Blob): Promise<boolean> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZipArchive(bytes)) {
    return false;
  }

  try {
    await loadProjectArchive(bytes);
    return true;
  } catch {
    // intentional: fallback to default
    return false;
  }
};

export const createProjectArchiveBlob = async (snapshot: ProjectSnapshot): Promise<Blob> => {
  const zip = new JSZip();
  const { attachments, manifest } = buildArchiveManifest(snapshot);

  for (const attachment of attachments || []) {
    zip.file(attachment.entry.path, attachment.bytes, {
      binary: true,
      compression: 'STORE',
    });
  }

  zip.file(PROJECT_ARCHIVE_MANIFEST_PATH, JSON.stringify(manifest), {
    compression: 'DEFLATE',
  });

  const archiveBytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 9,
    },
  });

  return new Blob([new Uint8Array(archiveBytes)], { type: PROJECT_ARCHIVE_MIME_TYPE });
};

export const readProjectImportData = async (file: Blob): Promise<unknown> => {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (isZipArchive(bytes)) {
    return decodeArchiveManifest(bytes);
  }

  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  assertProjectImportPayload(parsed);
  return parsed;
};

export const getProjectArchiveExtension = () => '.nous.zip';
