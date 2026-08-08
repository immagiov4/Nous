import type { ProjectAssetRef } from '@shared/projectAsset';
import {
  createProjectBackupArchive,
  inspectProjectBackupArchive,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
  type ProjectBackupLimits,
} from '@shared/projectBackupArchive';
import { collectProjectAssetReferences } from '@shared/projectBackupAssets';

import type { FileData, ProjectExportData, ProjectSnapshot } from '../../types.ts';
import { isRecord } from '../../utils/records.ts';
import { exportProjectData } from './projectSnapshot.ts';

const PROJECT_ARCHIVE_MIME_TYPE = 'application/zip';
const INVALID_BACKUP_ARCHIVE_MESSAGE =
  "Questo ZIP non contiene un backup Nous valido. Importa un file .nous.zip esportato dall'app.";
const INVALID_BACKUP_FILE_MESSAGE = 'Il file selezionato non e un backup Nous valido.';
// Base64 expands bytes by about one third; this keeps the complete import body
// below the backend's 300 MB JSON limit without imposing a per-file cutoff.
const PROJECT_ARCHIVE_LIMITS: ProjectBackupLimits = {
  invalidArchiveMessage: INVALID_BACKUP_ARCHIVE_MESSAGE,
  maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
  maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
};

export interface ProjectArchiveCreateOptions {
  cover?: FileData | null;
  loadAsset?: (ref: ProjectAssetRef) => Promise<Uint8Array>;
}

const isZipArchive = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
  (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);

export const hasZipFileSignature = async (file: Blob): Promise<boolean> =>
  isZipArchive(new Uint8Array(await file.slice(0, 4).arrayBuffer()));

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
  if (!isProjectImportPayload(value)) throw new Error(invalidMessage);
}

const inspectArchive = async (bytes: Uint8Array) => {
  const inspected = await inspectProjectBackupArchive<ProjectExportData>(
    bytes,
    PROJECT_ARCHIVE_LIMITS
  );
  assertProjectImportPayload(inspected.project, INVALID_BACKUP_ARCHIVE_MESSAGE);
  return inspected;
};

export const inspectProjectArchiveData = async (file: Blob): Promise<ProjectExportData> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZipArchive(bytes)) throw new Error(INVALID_BACKUP_ARCHIVE_MESSAGE);
  return (await inspectArchive(bytes)).project;
};

export const isProjectArchiveFile = async (file: Blob): Promise<boolean> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZipArchive(bytes)) return false;
  try {
    await inspectArchive(bytes);
    return true;
  } catch {
    return false;
  }
};

export const createProjectArchiveBlob = async (
  snapshot: ProjectSnapshot,
  options: ProjectArchiveCreateOptions = {}
): Promise<Blob> => {
  const project = exportProjectData(snapshot);
  const refs = collectProjectAssetReferences(project);
  const loadAsset = options.loadAsset;
  const assets = loadAsset
    ? await Promise.all(refs.map(async ref => ({ bytes: await loadAsset(ref), ref })))
    : [];
  const archiveBytes = await createProjectBackupArchive(
    { assets, cover: options.cover, project },
    PROJECT_ARCHIVE_LIMITS
  );
  return new Blob([Uint8Array.from(archiveBytes).buffer], { type: PROJECT_ARCHIVE_MIME_TYPE });
};

export const readLegacyProjectImportData = async (file: Blob): Promise<ProjectExportData> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  assertProjectImportPayload(parsed);
  return parsed;
};

export const getProjectArchiveExtension = () => '.nous.zip';
