import JSZip from 'jszip';
import type { CodebaseBundleSource, FileData, ProjectExportData, ProjectSnapshot } from '../../types.ts';
import { decodeBase64Bytes, encodeBytesBase64 } from './projectSource.ts';
import { exportProjectData } from './projectSnapshot.ts';

const PROJECT_ARCHIVE_FORMAT = 'lumina-project-archive';
const PROJECT_ARCHIVE_VERSION = 1;
const PROJECT_ARCHIVE_MIME_TYPE = 'application/zip';
const PROJECT_ARCHIVE_MANIFEST_PATH = 'project.json';
const PROJECT_ARCHIVE_SOURCE_DIR = 'source';

type ArchivedPdfFileMeta = Omit<FileData, 'data'>;

type ArchivedProjectSource =
  | {
      kind: 'pdf';
      file: ArchivedPdfFileMeta;
    }
  | CodebaseBundleSource;

interface ProjectArchiveAttachment {
  mimeType: string;
  name: string;
  path: string;
}

interface ProjectArchiveManifest {
  archiveVersion: number;
  attachments?: {
    sourceFile?: ProjectArchiveAttachment;
  };
  format: typeof PROJECT_ARCHIVE_FORMAT;
  project: Omit<ProjectExportData, 'file' | 'source'> & {
    source?: ArchivedProjectSource | null;
  };
}

const sanitizeArchivePathSegment = (value: string): string => {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return normalized || 'source';
};

const isZipArchive = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
  (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);

const buildArchiveManifest = (
  snapshot: ProjectSnapshot
): { attachment?: { bytes: Uint8Array; entry: ProjectArchiveAttachment }; manifest: ProjectArchiveManifest } => {
  const project = exportProjectData(snapshot);

  if (snapshot.source?.kind !== 'pdf') {
    return {
      manifest: {
        format: PROJECT_ARCHIVE_FORMAT,
        archiveVersion: PROJECT_ARCHIVE_VERSION,
        project: {
          ...project,
          source: project.source || null,
        },
      },
    };
  }

  const file = snapshot.source.file;
  const archivePath = `${PROJECT_ARCHIVE_SOURCE_DIR}/${sanitizeArchivePathSegment(file.name)}`;

  return {
    attachment: {
      bytes: decodeBase64Bytes(file.data),
      entry: {
        path: archivePath,
        name: file.name,
        mimeType: file.mimeType,
      },
    },
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
        ...project,
        source: {
          kind: 'pdf',
          file: {
            name: file.name,
            mimeType: file.mimeType,
          },
        },
      },
    },
  };
};

const decodeArchiveManifest = async (
  bytes: Uint8Array
): Promise<ProjectExportData> => {
  const zip = await JSZip.loadAsync(bytes);
  const manifestEntry = zip.file(PROJECT_ARCHIVE_MANIFEST_PATH);

  if (!manifestEntry) {
    throw new Error('Archivio backup non valido: manca project.json.');
  }

  const manifest = JSON.parse(await manifestEntry.async('string')) as ProjectArchiveManifest;

  if (manifest.format !== PROJECT_ARCHIVE_FORMAT) {
    throw new Error('Archivio backup non riconosciuto.');
  }

  if (!manifest.project || typeof manifest.project !== 'object') {
    throw new Error('Archivio backup non valido: manifest incompleto.');
  }

  if (manifest.attachments?.sourceFile && manifest.project.source?.kind === 'pdf') {
    const attachment = manifest.attachments.sourceFile;
    const attachmentEntry = zip.file(attachment.path);

    if (!attachmentEntry) {
      throw new Error(`Archivio backup non valido: manca ${attachment.path}.`);
    }

    const fileBytes = await attachmentEntry.async('uint8array');

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

  return manifest.project;
};

export const createProjectArchiveBlob = async (
  snapshot: ProjectSnapshot
): Promise<Blob> => {
  const zip = new JSZip();
  const { attachment, manifest } = buildArchiveManifest(snapshot);

  if (attachment) {
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

  return new Blob([archiveBytes], { type: PROJECT_ARCHIVE_MIME_TYPE });
};

export const readProjectImportData = async (file: Blob): Promise<unknown> => {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (isZipArchive(bytes)) {
    return decodeArchiveManifest(bytes);
  }

  return JSON.parse(new TextDecoder().decode(bytes));
};

export const getProjectArchiveExtension = () => '.lumina.zip';
