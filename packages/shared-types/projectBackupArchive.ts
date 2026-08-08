import JSZip from 'jszip';

import type { ProjectAssetRef } from './projectAsset';
import { collectProjectAssetReferences } from './projectBackupAssets';
import {
  loadZipSafely,
  readZipEntryBytesWithinLimit,
  readZipEntryTextWithinLimit,
} from './zipSafety';

export const PROJECT_BACKUP_ARCHIVE_FORMAT = 'nous-project-archive';
export const LEGACY_PROJECT_BACKUP_ARCHIVE_FORMAT = 'lumina-project-archive';
export const PROJECT_BACKUP_ARCHIVE_VERSION = 2;
export const PROJECT_BACKUP_MANIFEST_PATH = 'project.json';
export const PROJECT_BACKUP_MAX_ENTRIES = 128;
export const PROJECT_BACKUP_MAX_MANIFEST_BYTES = 20_000_000;
export const PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES = 200_000_000;
export const PROJECT_COVER_MAX_BYTES = 6 * 1024 * 1024;

const SOURCE_DIRECTORY = 'source';
const ASSET_DIRECTORY = 'assets';
const DOCUMENT_IMAGE_DIRECTORY = 'document-images';
const COVER_DIRECTORY = 'cover';
const BASE64_ENCODING_CHUNK_BYTES = 0x8000;
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u;
const PROJECT_COVER_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const isProjectCoverMediaType = (value: string): boolean =>
  PROJECT_COVER_MEDIA_TYPES.has(value);

export interface ProjectBackupLimits {
  invalidArchiveMessage: string;
  maxEntries: number;
  maxManifestBytes: number;
  maxTotalAttachmentBytes: number;
}

export interface ProjectBackupFile {
  data: string;
  mimeType: string;
  name: string;
}

export interface ProjectBackupAssetInput {
  bytes: Uint8Array;
  ref: ProjectAssetRef;
}

interface ProjectBackupFileAttachment {
  mimeType: string;
  name: string;
  path: string;
  sourceId?: string;
}

export interface ProjectBackupAssetAttachment extends ProjectAssetRef {
  path: string;
}

interface ProjectBackupDocumentImageAttachment {
  id: string;
  mediaType: string;
  path: string;
}

export interface ProjectBackupManifest {
  archiveVersion: number;
  attachments?: {
    assets?: ProjectBackupAssetAttachment[];
    cover?: ProjectBackupFileAttachment;
    documentImages?: ProjectBackupDocumentImageAttachment[];
    sourceFile?: ProjectBackupFileAttachment;
    sourceFiles?: ProjectBackupFileAttachment[];
  };
  format: typeof PROJECT_BACKUP_ARCHIVE_FORMAT | typeof LEGACY_PROJECT_BACKUP_ARCHIVE_FORMAT;
  project: unknown;
}

export interface DecodedProjectBackup<T = unknown> {
  archiveVersion: number;
  assets: readonly ProjectBackupAssetInput[];
  cover?: ProjectBackupFile;
  project: T;
}

export interface InspectedProjectBackup<T = unknown> {
  archiveVersion: number;
  project: T;
}

export class ProjectBackupArchiveError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'asset-invalid'
      | 'attachment-invalid'
      | 'manifest-invalid'
      | 'version-unsupported'
  ) {
    super(message);
    this.name = 'ProjectBackupArchiveError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sanitizePathSegment = (value: string): string => {
  const withoutControlCharacters = Array.from(value.trim(), character =>
    character <= '\u001f' ? '_' : character
  ).join('');
  return withoutControlCharacters.replaceAll(/[<>:"/\\|?*]/g, '_') || 'attachment';
};

const decodeBase64 = (value: string): Uint8Array => {
  const decoded = globalThis.atob(value.replaceAll(/\s/gu, ''));
  return Uint8Array.from(decoded, character => character.codePointAt(0) ?? 0);
};

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_ENCODING_CHUNK_BYTES) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + BASE64_ENCODING_CHUNK_BYTES));
  }
  return globalThis.btoa(binary);
};

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const assertFileMetadata = (value: unknown): value is ProjectBackupFileAttachment =>
  isRecord(value) &&
  typeof value.mimeType === 'string' &&
  Boolean(value.mimeType.trim()) &&
  typeof value.name === 'string' &&
  Boolean(value.name.trim()) &&
  typeof value.path === 'string' &&
  Boolean(value.path.trim());

const readSourceFile = (source: Record<string, unknown>): Record<string, unknown> => {
  if (!isRecord(source.file)) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: metadati della fonte mancanti.',
      'manifest-invalid'
    );
  }
  return source.file;
};

const readPortableFile = (value: Record<string, unknown>): ProjectBackupFile => {
  if (
    typeof value.data !== 'string' ||
    typeof value.mimeType !== 'string' ||
    !value.mimeType.trim() ||
    typeof value.name !== 'string' ||
    !value.name.trim()
  ) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: file allegato incompleto.',
      'attachment-invalid'
    );
  }
  return { data: value.data, mimeType: value.mimeType, name: value.name };
};

interface PendingAttachment {
  bytes: Uint8Array;
  path: string;
}

const detachSourceFiles = (
  project: Record<string, unknown>,
  attachments: NonNullable<ProjectBackupManifest['attachments']>,
  pending: PendingAttachment[]
): void => {
  if (project.source === null || project.source === undefined) return;
  if (!isRecord(project.source)) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: fonte non valida.',
      'manifest-invalid'
    );
  }
  const source = project.source;
  delete source.ref;
  const primaryFile = readSourceFile(source);
  if (Array.isArray(source.sources) && source.sources.length > 0) {
    const sourceAttachments: ProjectBackupFileAttachment[] = [];
    for (const [index, candidate] of source.sources.entries()) {
      if (!isRecord(candidate) || typeof candidate.id !== 'string') {
        throw new ProjectBackupArchiveError(
          'Archivio backup non valido: fonti incomplete.',
          'manifest-invalid'
        );
      }
      delete candidate.ref;
      const file = readPortableFile(readSourceFile(candidate));
      const path = `${SOURCE_DIRECTORY}/${String(index + 1).padStart(3, '0')}-${sanitizePathSegment(file.name)}`;
      sourceAttachments.push({
        mimeType: file.mimeType,
        name: file.name,
        path,
        sourceId: candidate.id,
      });
      pending.push({ bytes: decodeBase64(file.data), path });
      candidate.file = { ...readSourceFile(candidate), data: '' };
    }
    source.file = { ...primaryFile, data: '' };
    attachments.sourceFiles = sourceAttachments;
    return;
  }
  const file = readPortableFile(primaryFile);
  const path = `${SOURCE_DIRECTORY}/${sanitizePathSegment(file.name)}`;
  attachments.sourceFile = { mimeType: file.mimeType, name: file.name, path };
  pending.push({ bytes: decodeBase64(file.data), path });
  const { data: _embeddedBytes, ...portableFile } = primaryFile;
  source.file = portableFile;
};

const detachDocumentImages = (
  project: Record<string, unknown>,
  attachments: NonNullable<ProjectBackupManifest['attachments']>,
  pending: PendingAttachment[]
): void => {
  if (!isRecord(project.documentAssets) || !Array.isArray(project.documentAssets.usedImages)) {
    return;
  }
  const documentImages: ProjectBackupDocumentImageAttachment[] = [];
  for (const [index, candidate] of project.documentAssets.usedImages.entries()) {
    if (!isRecord(candidate) || typeof candidate.dataUrl !== 'string' || !candidate.dataUrl)
      continue;
    if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: immagine PDF senza identificatore.',
        'attachment-invalid'
      );
    }
    const match = DATA_URL_PATTERN.exec(candidate.dataUrl);
    if (!match?.[1] || !match[2]) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: immagine PDF non valida.',
        'attachment-invalid'
      );
    }
    if (typeof candidate.mimeType === 'string' && candidate.mimeType !== match[1]) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: tipo immagine PDF incoerente.',
        'attachment-invalid'
      );
    }
    const path = `${DOCUMENT_IMAGE_DIRECTORY}/${String(index + 1).padStart(3, '0')}-${sanitizePathSegment(candidate.id)}`;
    documentImages.push({ id: candidate.id, mediaType: match[1], path });
    pending.push({ bytes: decodeBase64(match[2]), path });
    candidate.dataUrl = '';
  }
  if (documentImages.length > 0) attachments.documentImages = documentImages;
};

const assertMatchingAssetBytes = async (ref: ProjectAssetRef, bytes: Uint8Array): Promise<void> => {
  if (bytes.byteLength !== ref.byteSize || (await sha256(bytes)) !== ref.hash) {
    throw new ProjectBackupArchiveError(
      `Archivio backup non valido: asset ${ref.id} non valido.`,
      'asset-invalid'
    );
  }
};

const detachDurableAssets = async (
  project: Record<string, unknown>,
  assetInputs: readonly ProjectBackupAssetInput[],
  attachments: NonNullable<ProjectBackupManifest['attachments']>,
  pending: PendingAttachment[]
): Promise<void> => {
  const reachable = collectProjectAssetReferences(project);
  const inputsById = new Map(assetInputs.map(asset => [asset.ref.id, asset]));
  if (inputsById.size !== assetInputs.length || inputsById.size !== reachable.length) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: insieme degli asset incompleto.',
      'asset-invalid'
    );
  }
  const assetAttachments: ProjectBackupAssetAttachment[] = [];
  for (const ref of reachable) {
    const input = inputsById.get(ref.id);
    if (
      input?.ref.byteSize !== ref.byteSize ||
      input.ref.hash !== ref.hash ||
      input.ref.mediaType !== ref.mediaType
    ) {
      throw new ProjectBackupArchiveError(
        `Archivio backup non valido: asset ${ref.id} non valido.`,
        'asset-invalid'
      );
    }
    await assertMatchingAssetBytes(ref, input.bytes);
    const path = `${ASSET_DIRECTORY}/${ref.id}`;
    assetAttachments.push({ ...ref, path });
    pending.push({ bytes: input.bytes, path });
  }
  attachments.assets = assetAttachments;
};

export const createProjectBackupArchive = async <T>(
  input: {
    assets?: readonly ProjectBackupAssetInput[];
    cover?: ProjectBackupFile | null;
    project: T;
  },
  limits: ProjectBackupLimits
): Promise<Uint8Array> => {
  const project = structuredClone(input.project);
  if (!isRecord(project)) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: progetto mancante.',
      'manifest-invalid'
    );
  }
  const attachments: NonNullable<ProjectBackupManifest['attachments']> = {};
  const pending: PendingAttachment[] = [];
  detachSourceFiles(project, attachments, pending);
  detachDocumentImages(project, attachments, pending);
  await detachDurableAssets(project, input.assets ?? [], attachments, pending);
  if (input.cover) {
    if (!isProjectCoverMediaType(input.cover.mimeType)) {
      throw new ProjectBackupArchiveError(
        'Il formato della copertina del progetto non è supportato.',
        'attachment-invalid'
      );
    }
    const path = `${COVER_DIRECTORY}/${sanitizePathSegment(input.cover.name)}`;
    const bytes = decodeBase64(input.cover.data);
    if (bytes.byteLength > PROJECT_COVER_MAX_BYTES) {
      throw new ProjectBackupArchiveError(
        'La copertina del progetto supera la dimensione massima consentita.',
        'attachment-invalid'
      );
    }
    attachments.cover = { mimeType: input.cover.mimeType, name: input.cover.name, path };
    pending.push({ bytes, path });
  }
  const totalAttachmentBytes = pending.reduce((total, entry) => total + entry.bytes.byteLength, 0);
  if (totalAttachmentBytes > limits.maxTotalAttachmentBytes) {
    throw new ProjectBackupArchiveError(
      `Gli allegati del corso superano il limite totale di ${limits.maxTotalAttachmentBytes} byte.`,
      'attachment-invalid'
    );
  }
  const zip = new JSZip();
  for (const attachment of pending) {
    zip.file(attachment.path, attachment.bytes, { binary: true, compression: 'STORE' });
  }
  const manifest: ProjectBackupManifest = {
    archiveVersion: PROJECT_BACKUP_ARCHIVE_VERSION,
    attachments,
    format: PROJECT_BACKUP_ARCHIVE_FORMAT,
    project,
  };
  const serializedManifest = JSON.stringify(manifest);
  if (new TextEncoder().encode(serializedManifest).byteLength > limits.maxManifestBytes) {
    throw new ProjectBackupArchiveError(
      `Il manifest del backup supera il limite di ${limits.maxManifestBytes} byte.`,
      'manifest-invalid'
    );
  }
  zip.file(PROJECT_BACKUP_MANIFEST_PATH, serializedManifest, { compression: 'DEFLATE' });
  if (Object.keys(zip.files).length > limits.maxEntries) {
    throw new ProjectBackupArchiveError(
      `Il backup contiene più di ${limits.maxEntries} file.`,
      'attachment-invalid'
    );
  }
  return zip.generateAsync({
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    type: 'uint8array',
  });
};

interface AttachmentReader {
  allowedPaths: Set<string>;
  read(entry: ProjectBackupFileAttachment | ProjectBackupAssetAttachment): Promise<Uint8Array>;
}

const createAttachmentReader = (zip: JSZip, limits: ProjectBackupLimits): AttachmentReader => {
  let totalBytes = 0;
  const allowedPaths = new Set([PROJECT_BACKUP_MANIFEST_PATH]);
  return {
    allowedPaths,
    async read(entry) {
      const zipEntry = zip.file(entry.path);
      if (!zipEntry) {
        throw new ProjectBackupArchiveError(
          `Archivio backup non valido: manca ${entry.path}.`,
          'attachment-invalid'
        );
      }
      allowedPaths.add(entry.path);
      const bytes = await readZipEntryBytesWithinLimit(
        zipEntry,
        limits.maxTotalAttachmentBytes,
        limits.invalidArchiveMessage
      );
      totalBytes += bytes.byteLength;
      if (totalBytes > limits.maxTotalAttachmentBytes) {
        throw new ProjectBackupArchiveError(
          `Gli allegati del corso superano il limite totale di ${limits.maxTotalAttachmentBytes} byte.`,
          'attachment-invalid'
        );
      }
      return bytes;
    },
  };
};

const restoreMultipleSourceFiles = async (
  source: Record<string, unknown>,
  primaryFile: Record<string, unknown>,
  sources: unknown[],
  sourceFiles: ProjectBackupFileAttachment[],
  reader: AttachmentReader
): Promise<void> => {
  const filesBySourceId = new Map<string, ProjectBackupFile>();
  for (const attachment of sourceFiles) {
    if (!attachment.sourceId || filesBySourceId.has(attachment.sourceId)) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: allegati delle fonti incompleti.',
        'attachment-invalid'
      );
    }
    filesBySourceId.set(attachment.sourceId, {
      data: encodeBase64(await reader.read(attachment)),
      mimeType: attachment.mimeType,
      name: attachment.name,
    });
  }
  const restoredSources = sources.map(candidate => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: fonti incomplete.',
        'manifest-invalid'
      );
    }
    const file = filesBySourceId.get(candidate.id);
    if (!file) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: allegati delle fonti incompleti.',
        'attachment-invalid'
      );
    }
    return {
      ...candidate,
      file: { ...readSourceFile(candidate), ...file, sourceId: candidate.id },
      id: candidate.id,
    };
  });
  source.sources = restoredSources;
  const primarySourceId =
    typeof primaryFile.sourceId === 'string' ? primaryFile.sourceId : undefined;
  const primarySource = restoredSources.find(
    candidate => isRecord(candidate) && candidate.id === primarySourceId
  );
  if (!isRecord(primarySource) || !isRecord(primarySource.file)) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: fonte primaria mancante.',
      'attachment-invalid'
    );
  }
  source.file = primarySource.file;
};

const restoreSourceFiles = async (
  project: Record<string, unknown>,
  attachments: ProjectBackupManifest['attachments'],
  reader: AttachmentReader
): Promise<void> => {
  if (project.source === null || project.source === undefined) return;
  if (!isRecord(project.source)) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: fonte non valida.',
      'manifest-invalid'
    );
  }
  const source = project.source;
  const primaryFile = readSourceFile(source);
  if (Array.isArray(source.sources) && source.sources.length > 0) {
    const sourceFiles = attachments?.sourceFiles;
    if (sourceFiles?.length !== source.sources.length || !sourceFiles?.every(assertFileMetadata)) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: allegati delle fonti incompleti.',
        'attachment-invalid'
      );
    }
    await restoreMultipleSourceFiles(source, primaryFile, source.sources, sourceFiles, reader);
    return;
  }
  const attachment = attachments?.sourceFile;
  if (attachment) {
    if (!assertFileMetadata(attachment)) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: allegato della fonte incompleto.',
        'attachment-invalid'
      );
    }
    source.file = {
      ...primaryFile,
      data: encodeBase64(await reader.read(attachment)),
      mimeType: attachment.mimeType,
      name: attachment.name,
    };
    return;
  }
  if (typeof primaryFile.data !== 'string' || !primaryFile.data) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: allegato della fonte mancante.',
      'attachment-invalid'
    );
  }
};

const restoreDocumentImages = async (
  project: Record<string, unknown>,
  attachments: ProjectBackupManifest['attachments'],
  reader: AttachmentReader
): Promise<void> => {
  if (!isRecord(project.documentAssets) || !Array.isArray(project.documentAssets.usedImages)) {
    if ((attachments?.documentImages?.length ?? 0) > 0) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: immagini PDF non dichiarate.',
        'attachment-invalid'
      );
    }
    return;
  }
  const imagesNeedingBytes = project.documentAssets.usedImages.filter(
    image => isRecord(image) && image.dataUrl === ''
  );
  const documentImages = attachments?.documentImages ?? [];
  if (imagesNeedingBytes.length !== documentImages.length) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: allegati delle immagini PDF incompleti.',
      'attachment-invalid'
    );
  }
  const attachmentsById = new Map(documentImages.map(entry => [entry.id, entry]));
  if (attachmentsById.size !== documentImages.length) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: allegati delle immagini PDF duplicati.',
      'attachment-invalid'
    );
  }
  for (const image of imagesNeedingBytes) {
    if (!isRecord(image) || typeof image.id !== 'string') continue;
    const attachment = attachmentsById.get(image.id);
    if (
      !attachment ||
      !assertFileMetadata({
        ...attachment,
        mimeType: attachment.mediaType,
        name: image.id,
      })
    ) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: allegati delle immagini PDF incompleti.',
        'attachment-invalid'
      );
    }
    if (typeof image.mimeType === 'string' && image.mimeType !== attachment.mediaType) {
      throw new ProjectBackupArchiveError(
        'Archivio backup non valido: tipo immagine PDF incoerente.',
        'attachment-invalid'
      );
    }
    image.dataUrl = `data:${attachment.mediaType};base64,${encodeBase64(
      await reader.read({
        ...attachment,
        mimeType: attachment.mediaType,
        name: image.id,
      })
    )}`;
  }
};

const readDurableAssets = async (
  project: Record<string, unknown>,
  manifest: ProjectBackupManifest,
  reader: AttachmentReader
): Promise<readonly ProjectBackupAssetInput[]> => {
  const reachable = collectProjectAssetReferences(project);
  if (manifest.archiveVersion === 1) {
    if (reachable.length > 0) {
      throw new ProjectBackupArchiveError(
        'Archivio backup v1 non valido: contiene riferimenti ad asset senza byte.',
        'asset-invalid'
      );
    }
    return [];
  }
  if (manifest.archiveVersion !== PROJECT_BACKUP_ARCHIVE_VERSION) {
    throw new ProjectBackupArchiveError(
      `Versione archivio progetto non supportata: ${manifest.archiveVersion}.`,
      'version-unsupported'
    );
  }
  const assetEntries = manifest.attachments?.assets;
  if (!Array.isArray(assetEntries) || assetEntries.length !== reachable.length) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: insieme degli asset incompleto.',
      'asset-invalid'
    );
  }
  const entriesById = new Map(assetEntries.map(entry => [entry.id, entry]));
  if (entriesById.size !== assetEntries.length) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: asset duplicati.',
      'asset-invalid'
    );
  }
  const assets: ProjectBackupAssetInput[] = [];
  for (const ref of reachable) {
    const entry = entriesById.get(ref.id);
    if (
      entry?.byteSize !== ref.byteSize ||
      entry.hash !== ref.hash ||
      entry.mediaType !== ref.mediaType ||
      entry.path !== `${ASSET_DIRECTORY}/${ref.id}`
    ) {
      throw new ProjectBackupArchiveError(
        `Archivio backup non valido: asset ${ref.id} non valido.`,
        'asset-invalid'
      );
    }
    const bytes = await reader.read(entry);
    await assertMatchingAssetBytes(ref, bytes);
    assets.push({ bytes, ref });
  }
  return Object.freeze(assets);
};

const readCover = async (
  attachment: ProjectBackupFileAttachment | undefined,
  reader: AttachmentReader
): Promise<ProjectBackupFile | undefined> => {
  if (!attachment) return undefined;
  if (!assertFileMetadata(attachment)) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: copertina incompleta.',
      'attachment-invalid'
    );
  }
  if (!isProjectCoverMediaType(attachment.mimeType)) {
    throw new ProjectBackupArchiveError(
      'Il formato della copertina del progetto non è supportato.',
      'attachment-invalid'
    );
  }
  const bytes = await reader.read(attachment);
  if (bytes.byteLength > PROJECT_COVER_MAX_BYTES) {
    throw new ProjectBackupArchiveError(
      'La copertina del progetto supera la dimensione massima consentita.',
      'attachment-invalid'
    );
  }
  return {
    data: encodeBase64(bytes),
    mimeType: attachment.mimeType,
    name: attachment.name,
  };
};

const assertNoUndeclaredEntries = (zip: JSZip, allowedPaths: ReadonlySet<string>): void => {
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir && !allowedPaths.has(entry.name)) {
      throw new ProjectBackupArchiveError(
        `Archivio backup non valido: file non dichiarato ${entry.name}.`,
        'attachment-invalid'
      );
    }
  }
};

interface LoadedProjectBackupManifest {
  manifest: ProjectBackupManifest;
  zip: JSZip;
}

const assertLegacyV1Attachments = (manifest: ProjectBackupManifest): void => {
  if (manifest.archiveVersion !== 1 || !manifest.attachments) return;
  if (
    Object.hasOwn(manifest.attachments, 'assets') ||
    Object.hasOwn(manifest.attachments, 'cover') ||
    Object.hasOwn(manifest.attachments, 'documentImages')
  ) {
    throw new ProjectBackupArchiveError(
      'Archivio backup v1 non valido: contiene allegati introdotti da versioni successive.',
      'version-unsupported'
    );
  }
};

const loadProjectBackupManifest = async (
  bytes: Uint8Array,
  limits: ProjectBackupLimits
): Promise<LoadedProjectBackupManifest> => {
  const zip = await loadZipSafely(bytes, {
    invalidArchiveMessage: limits.invalidArchiveMessage,
    maxEntries: limits.maxEntries,
    maxTotalUncompressedBytes: limits.maxManifestBytes + limits.maxTotalAttachmentBytes,
  });
  const manifestEntry = zip.file(PROJECT_BACKUP_MANIFEST_PATH);
  if (!manifestEntry) throw new Error(limits.invalidArchiveMessage);
  const parsedManifest = JSON.parse(
    await readZipEntryTextWithinLimit(
      manifestEntry,
      limits.maxManifestBytes,
      limits.invalidArchiveMessage
    )
  ) as unknown;
  if (!isRecord(parsedManifest)) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: manifest incompleto.',
      'manifest-invalid'
    );
  }
  const manifest = parsedManifest as unknown as ProjectBackupManifest;
  if (
    manifest.format !== PROJECT_BACKUP_ARCHIVE_FORMAT &&
    manifest.format !== LEGACY_PROJECT_BACKUP_ARCHIVE_FORMAT
  ) {
    throw new Error(limits.invalidArchiveMessage);
  }
  if (
    !isRecord(manifest.project) ||
    !Number.isSafeInteger(manifest.archiveVersion) ||
    (manifest.attachments !== undefined && !isRecord(manifest.attachments))
  ) {
    throw new ProjectBackupArchiveError(
      'Archivio backup non valido: manifest incompleto.',
      'manifest-invalid'
    );
  }
  if (manifest.archiveVersion !== 1 && manifest.archiveVersion !== PROJECT_BACKUP_ARCHIVE_VERSION) {
    throw new ProjectBackupArchiveError(
      `Versione archivio progetto non supportata: ${manifest.archiveVersion}.`,
      'version-unsupported'
    );
  }
  assertLegacyV1Attachments(manifest);
  return { manifest, zip };
};

export const inspectProjectBackupArchive = async <T = unknown>(
  bytes: Uint8Array,
  limits: ProjectBackupLimits
): Promise<InspectedProjectBackup<T>> => {
  const { manifest } = await loadProjectBackupManifest(bytes, limits);
  return {
    archiveVersion: manifest.archiveVersion,
    project: structuredClone(manifest.project) as T,
  };
};

export const decodeProjectBackupArchive = async <T = unknown>(
  bytes: Uint8Array,
  limits: ProjectBackupLimits
): Promise<DecodedProjectBackup<T>> => {
  const { manifest, zip } = await loadProjectBackupManifest(bytes, limits);
  const project = structuredClone(manifest.project) as Record<string, unknown>;
  const reader = createAttachmentReader(zip, limits);
  await restoreSourceFiles(project, manifest.attachments, reader);
  const assets = await readDurableAssets(project, manifest, reader);
  if (manifest.archiveVersion === 1) {
    await restoreDocumentImages(project, undefined, reader);
    assertNoUndeclaredEntries(zip, reader.allowedPaths);
    return {
      archiveVersion: manifest.archiveVersion,
      assets,
      project: project as T,
    };
  }

  await restoreDocumentImages(project, manifest.attachments, reader);
  const cover = await readCover(manifest.attachments?.cover, reader);
  assertNoUndeclaredEntries(zip, reader.allowedPaths);
  return {
    archiveVersion: manifest.archiveVersion,
    assets,
    ...(cover ? { cover } : {}),
    project: project as T,
  };
};
