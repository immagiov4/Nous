import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import { assessPdfTextQuality } from '@shared/pdfTextQuality';
import { createSourceArchivePreview } from '@shared/sourceArchivePreview';
import type {
  SourceArchivePdfWarningDetail,
  SourceArchivePdfWarningReason,
} from '@shared/sourceArchiveWarnings';
import JSZip from 'jszip';
import { PDF_SOURCE_EXTRACTION_OPTIONS } from '../services/pdfSourceLimits.js';
import {
  extractPdfText,
  PdfTextExtractionOutputLimitError,
  PdfTextExtractionTimeoutError,
} from '../services/pdfTextExtractor.js';
import { encodePdfDataUrl } from '../utils/pdfDataUrl.js';
import { openFileSourceArchive } from './fileSourceArchive.js';

export interface SourceArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
}

export const PROJECT_SOURCE_ARCHIVE_LIMITS: SourceArchiveLimits = {
  maxEntries: COURSE_SOURCE_UPLOAD_LIMITS.maxArchiveEntries,
  maxEntryBytes: COURSE_SOURCE_UPLOAD_LIMITS.maxArchiveEntryBytes,
  maxExpandedBytes: COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes,
};

export const PROJECT_SOURCE_ARCHIVE_MAX_COMPRESSED_BYTES =
  COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes;
export const PROJECT_SOURCE_ARCHIVE_PDF_POLICY = {
  archivePreparationTimeoutMs: 480_000,
  ...PDF_SOURCE_EXTRACTION_OPTIONS,
  maxEntryBytes: COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes,
} as const;

export class SourceArchivePreparationCapacityError extends Error {
  constructor() {
    super('È già in corso la preparazione di un archivio ZIP. Riprova tra poco.');
    this.name = 'SourceArchivePreparationCapacityError';
  }
}

export class SourceArchivePreparationError extends Error {
  constructor(reason: string) {
    super(`Invalid source archive: ${reason}.`);
    this.name = 'SourceArchivePreparationError';
  }
}

export class SourceArchiveUnusableError extends Error {
  readonly warnings: SourceArchivePdfWarningDetail[];

  constructor(warnings: SourceArchivePdfWarningDetail[]) {
    super('L’archivio non contiene alcun testo utilizzabile.');
    this.name = 'SourceArchiveUnusableError';
    this.warnings = warnings;
  }
}

const activeSourceArchivePreparationUsers = new Set<string>();

export interface SourceArchivePreparationAdmission {
  release: () => void;
}

export const acquireSourceArchivePreparationAdmission = (
  userId: string
): SourceArchivePreparationAdmission => {
  if (
    activeSourceArchivePreparationUsers.size > 0 ||
    activeSourceArchivePreparationUsers.has(userId)
  ) {
    throw new SourceArchivePreparationCapacityError();
  }
  activeSourceArchivePreparationUsers.add(userId);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      activeSourceArchivePreparationUsers.delete(userId);
    },
  };
};

export const withSourceArchivePreparationAdmission = async <T>(
  userId: string,
  prepare: () => Promise<T>
): Promise<T> => {
  const admission = acquireSourceArchivePreparationAdmission(userId);
  try {
    return await prepare();
  } finally {
    admission.release();
  }
};

export interface SourceArchiveDirectoryEntry {
  explicit: boolean;
  kind: 'directory';
  path: string;
}

export interface SourceArchiveFileEntry {
  byteSize: number;
  content: Uint8Array;
  hash: string;
  kind: 'file';
  path: string;
  preview?: string;
  text?: string;
  warningReason?: SourceArchivePdfWarningReason;
}

export type SourceArchiveEntry = SourceArchiveDirectoryEntry | SourceArchiveFileEntry;

export interface SourceArchiveIndex {
  entries: SourceArchiveEntry[];
  fileCount: number;
  totalExpandedBytes: number;
}

interface JsZipCompressedObject {
  uncompressedSize?: number;
}

interface JsZipUint8Stream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): JsZipUint8Stream;
  on(event: 'end', callback: () => void): JsZipUint8Stream;
  on(event: 'error', callback: (error: Error) => void): JsZipUint8Stream;
  pause(): JsZipUint8Stream;
  resume(): JsZipUint8Stream;
}

interface JsZipEntryWithMetadata extends JSZip.JSZipObject {
  _data?: JsZipCompressedObject;
  internalStream(type: 'uint8array'): JsZipUint8Stream;
}

interface JsZipCentralEntry {
  decompressed?: JsZipCompressedObject;
  dir: boolean;
  fileNameStr: string;
}

interface JsZipCentralDirectory {
  files: JsZipCentralEntry[];
  load(data: Uint8Array): void;
}

type JsZipCentralDirectoryConstructor = new (options: {
  decodeFileName(bytes: Uint8Array): string;
}) => JsZipCentralDirectory;

// JSZip intentionally keeps this metadata private. The exact dependency version is pinned because
// original directory paths and duplicate central-directory records are lost by the public loader.
const JsZipCentralDirectoryParser = createRequire(import.meta.url)(
  'jszip/lib/zipEntries.js'
) as JsZipCentralDirectoryConstructor;

const invalidArchive = (reason: string) => new SourceArchivePreparationError(reason);

export const assertSourceArchiveCompressedSize = (byteLength: number): void => {
  if (byteLength > PROJECT_SOURCE_ARCHIVE_MAX_COMPRESSED_BYTES) {
    throw invalidArchive('compressed size limit exceeded');
  }
};

const validateLimits = (limits: SourceArchiveLimits) => {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid source archive limit: ${name}.`);
    }
  }
};

const normalizeArchivePath = (path: string, directory: boolean) => {
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    (path.length >= 3 &&
      path[1] === ':' &&
      path[2] === '/' &&
      ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')))
  ) {
    throw invalidArchive(`unsafe path "${path}"`);
  }

  const normalizedPath = directory && path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = normalizedPath.split('/');
  if (
    normalizedPath.length === 0 ||
    segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw invalidArchive(`unsafe path "${path}"`);
  }

  return normalizedPath;
};

const parseCentralDirectory = (archiveBytes: Uint8Array) => {
  const parser = new JsZipCentralDirectoryParser({
    decodeFileName: bytes => new TextDecoder().decode(bytes),
  });

  try {
    parser.load(archiveBytes);
  } catch {
    throw invalidArchive('unreadable ZIP');
  }

  return parser.files;
};

const readUncompressedSize = (entry: JsZipCentralEntry) => {
  const uncompressedSize = entry.decompressed?.uncompressedSize;
  if (
    typeof uncompressedSize !== 'number' ||
    !Number.isSafeInteger(uncompressedSize) ||
    uncompressedSize < 0
  ) {
    throw invalidArchive('missing uncompressed size metadata');
  }
  return uncompressedSize;
};

const validateTreePaths = (
  entriesByPath: Map<string, { directory: boolean; uncompressedSize: number }>
) => {
  for (const path of entriesByPath.keys()) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parentPath = segments.slice(0, index).join('/');
      if (entriesByPath.get(parentPath)?.directory === false) {
        throw invalidArchive(`duplicate path "${parentPath}"`);
      }
    }
  }
};

const inspectCentralDirectory = (
  centralEntries: JsZipCentralEntry[],
  limits: SourceArchiveLimits
) => {
  if (centralEntries.length > limits.maxEntries) {
    throw invalidArchive('entry limit exceeded');
  }

  const entriesByPath = new Map<string, { directory: boolean; uncompressedSize: number }>();
  let totalExpandedBytes = 0;

  for (const entry of centralEntries) {
    const path = normalizeArchivePath(entry.fileNameStr, entry.dir);
    if (entriesByPath.has(path)) {
      throw invalidArchive(`duplicate path "${path}"`);
    }

    const uncompressedSize = readUncompressedSize(entry);
    if (!entry.dir && uncompressedSize > limits.maxEntryBytes) {
      throw invalidArchive(`file size limit exceeded for "${path}"`);
    }
    if (!entry.dir) {
      totalExpandedBytes += uncompressedSize;
      if (
        !Number.isSafeInteger(totalExpandedBytes) ||
        totalExpandedBytes > limits.maxExpandedBytes
      ) {
        throw invalidArchive('expanded size limit exceeded');
      }
    }

    entriesByPath.set(path, {
      directory: entry.dir,
      uncompressedSize,
    });
  }

  validateTreePaths(entriesByPath);
  return { entriesByPath, totalExpandedBytes };
};

const loadArchive = async (archiveBytes: Uint8Array) => {
  try {
    return await JSZip.loadAsync(archiveBytes, {
      checkCRC32: false,
      createFolders: false,
    });
  } catch {
    throw invalidArchive('unreadable ZIP');
  }
};

const validateLoadedEntrySize = (
  entry: JsZipEntryWithMetadata,
  path: string,
  expectedSize: number
) => {
  const size = entry._data?.uncompressedSize;
  // Empty JSZip entries expose promises, so the directory remains authoritative for their size.
  if (size === undefined && expectedSize === 0) return;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
    throw invalidArchive('missing uncompressed size metadata');
  if (size !== expectedSize) throw invalidArchive(`inconsistent uncompressed size for "${path}"`);
};

const mapLoadedEntries = (
  loadedArchive: JSZip,
  centralEntriesByPath: Map<string, { directory: boolean; uncompressedSize: number }>
) => {
  const loadedEntriesByPath = new Map<string, JsZipEntryWithMetadata>();

  for (const loadedEntry of Object.values(loadedArchive.files)) {
    const path = normalizeArchivePath(
      loadedEntry.unsafeOriginalName ?? loadedEntry.name,
      loadedEntry.dir
    );
    if (loadedEntriesByPath.has(path)) {
      throw invalidArchive(`duplicate path "${path}"`);
    }
    loadedEntriesByPath.set(path, loadedEntry as JsZipEntryWithMetadata);
  }

  if (loadedEntriesByPath.size !== centralEntriesByPath.size) {
    throw invalidArchive('duplicate path');
  }

  for (const [path, metadata] of centralEntriesByPath) {
    const loadedEntry = loadedEntriesByPath.get(path);
    if (loadedEntry?.dir !== metadata.directory) {
      throw invalidArchive(`inconsistent path "${path}"`);
    }
    if (metadata.directory) {
      continue;
    }

    validateLoadedEntrySize(loadedEntry, path, metadata.uncompressedSize);
  }

  return loadedEntriesByPath;
};

const addParentDirectories = (
  directories: Map<string, SourceArchiveDirectoryEntry>,
  path: string
) => {
  const segments = path.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const parentPath = segments.slice(0, index).join('/');
    if (!directories.has(parentPath)) {
      directories.set(parentPath, {
        explicit: false,
        kind: 'directory',
        path: parentPath,
      });
    }
  }
};

const decodeUtf8 = (content: Uint8Array) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
};

const readEntryContent = (
  loadedEntry: JsZipEntryWithMetadata,
  path: string,
  expectedSize: number,
  maxEntryBytes: number,
  remainingExpandedBytes: number,
  deadlineAt: number
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const content = new Uint8Array(expectedSize);
    const stream = loadedEntry.internalStream('uint8array');
    let offset = 0;
    let settled = false;
    let deadlineTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadlineTimer !== undefined) globalThis.clearTimeout(deadlineTimer);
      stream.pause();
      reject(error);
    };

    deadlineTimer = globalThis.setTimeout(
      () => fail(invalidArchive('preparation deadline exceeded')),
      Math.max(1, deadlineAt - Date.now())
    );

    stream
      .on('data', chunk => {
        const nextOffset = offset + chunk.byteLength;
        if (nextOffset > maxEntryBytes) {
          fail(invalidArchive(`file size limit exceeded for "${path}"`));
          return;
        }
        if (nextOffset > remainingExpandedBytes) {
          fail(invalidArchive('expanded size limit exceeded'));
          return;
        }
        if (nextOffset > expectedSize) {
          fail(invalidArchive(`inconsistent uncompressed size for "${path}"`));
          return;
        }
        content.set(chunk, offset);
        offset = nextOffset;
      })
      .on('error', () => fail(invalidArchive(`cannot decompress "${path}"`)))
      .on('end', () => {
        if (settled) {
          return;
        }
        if (offset !== expectedSize) {
          fail(invalidArchive(`inconsistent uncompressed size for "${path}"`));
          return;
        }
        settled = true;
        if (deadlineTimer !== undefined) globalThis.clearTimeout(deadlineTimer);
        resolve(content);
      })
      .resume();
  });

const compareEntryPaths = (
  left: Pick<SourceArchiveEntry, 'path'>,
  right: Pick<SourceArchiveEntry, 'path'>
) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

const isPdfArchivePath = (path: string): boolean => path.toLowerCase().endsWith('.pdf');

const toBinarySourceArchiveFile = (
  entry: SourceArchiveFileEntry,
  warningReason: SourceArchivePdfWarningReason
): SourceArchiveFileEntry => ({
  byteSize: entry.byteSize,
  content: entry.content,
  hash: entry.hash,
  kind: 'file',
  path: entry.path,
  warningReason,
});

interface PdfPreparationBudget {
  deadlineAt: number;
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(new PdfTextExtractionTimeoutError('pdf-parse')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
};

const withArchivePreparationDeadline = async <T>(
  promise: Promise<T>,
  deadlineAt: number
): Promise<T> => {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(invalidArchive('preparation deadline exceeded')),
          Math.max(1, deadlineAt - Date.now())
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
};

const admitPdfEntry = (
  entry: SourceArchiveFileEntry,
  budget: PdfPreparationBudget
): SourceArchivePdfWarningReason | undefined => {
  if (entry.byteSize > PROJECT_SOURCE_ARCHIVE_PDF_POLICY.maxEntryBytes) {
    return 'safety-limit';
  }
  if (Date.now() >= budget.deadlineAt) {
    return 'timeout';
  }
  return undefined;
};

const prepareSourceArchiveFile = async (
  entry: SourceArchiveFileEntry,
  maxPreparedBytes: number,
  pdfBudget: PdfPreparationBudget
): Promise<SourceArchiveFileEntry> => {
  if (!isPdfArchivePath(entry.path)) {
    return entry;
  }

  const admissionWarning = admitPdfEntry(entry, pdfBudget);
  if (admissionWarning) {
    return toBinarySourceArchiveFile(entry, admissionWarning);
  }
  if (maxPreparedBytes <= 0) {
    return toBinarySourceArchiveFile(entry, 'safety-limit');
  }

  try {
    const remainingArchiveMs = Math.max(1, pdfBudget.deadlineAt - Date.now());
    const pdfTimeoutMs = Math.min(
      PROJECT_SOURCE_ARCHIVE_PDF_POLICY.pdftotextTimeoutMs +
        PROJECT_SOURCE_ARCHIVE_PDF_POLICY.fallbackTimeoutMs,
      remainingArchiveMs
    );
    const pdftotextTimeoutMs = Math.min(
      PROJECT_SOURCE_ARCHIVE_PDF_POLICY.pdftotextTimeoutMs,
      Math.ceil(pdfTimeoutMs / 2)
    );
    const fallbackTimeoutMs = Math.min(
      PROJECT_SOURCE_ARCHIVE_PDF_POLICY.fallbackTimeoutMs,
      pdfTimeoutMs - pdftotextTimeoutMs
    );
    const extractedPdf = await withTimeout(
      extractPdfText(encodePdfDataUrl(entry.content), {
        fallbackTimeoutMs,
        maxOutputBytes: Math.min(
          maxPreparedBytes,
          PROJECT_SOURCE_ARCHIVE_PDF_POLICY.maxOutputBytes
        ),
        pdftotextTimeoutMs,
        fallbackProcessMaxOldGenerationSizeMb:
          PDF_SOURCE_EXTRACTION_OPTIONS.fallbackProcessMaxOldGenerationSizeMb,
      }),
      pdfTimeoutMs
    );
    const extractedText = extractedPdf.text.trim();
    if (
      extractedText &&
      assessPdfTextQuality({
        extractedText,
        pageCount: extractedPdf.pageCount,
        pages: extractedPdf.pages,
      }).status === 'ok'
    ) {
      const content = new TextEncoder().encode(extractedText);
      if (content.byteLength > maxPreparedBytes) {
        console.warn('[Backend] Extracted PDF text exceeds source archive limits.', {
          path: entry.path,
        });
        return toBinarySourceArchiveFile(entry, 'safety-limit');
      }
      return {
        ...entry,
        byteSize: content.byteLength,
        content,
        hash: createHash('sha256').update(content).digest('hex'),
        preview: createSourceArchivePreview(extractedText),
        text: extractedText,
      };
    }
  } catch (error) {
    console.warn('[Backend] PDF text extraction failed for a source archive entry.', {
      error,
      path: entry.path,
    });
    let warningReason: SourceArchivePdfWarningReason = 'parser-failed';
    if (error instanceof PdfTextExtractionTimeoutError) warningReason = 'timeout';
    if (error instanceof PdfTextExtractionOutputLimitError) warningReason = 'safety-limit';
    return toBinarySourceArchiveFile(entry, warningReason);
  }

  return toBinarySourceArchiveFile(entry, 'no-usable-text');
};

const openArchiveContent = async (
  input: Uint8Array | string,
  limits: SourceArchiveLimits,
  deadlineAt: number
) => {
  if (typeof input === 'string') {
    const archive = await openFileSourceArchive(input, limits.maxEntries, deadlineAt).catch(() => {
      throw invalidArchive('unreadable ZIP');
    });
    try {
      return {
        ...inspectCentralDirectory(archive.entries, limits),
        close: archive.close,
        read: (path: string) =>
          archive.read(path, deadlineAt).catch(() => {
            throw invalidArchive(`cannot decompress "${path}"`);
          }),
      };
    } catch (error) {
      archive.close();
      throw error;
    }
  }
  const inspected = inspectCentralDirectory(parseCentralDirectory(input), limits);
  const entries = mapLoadedEntries(
    await withArchivePreparationDeadline(loadArchive(input), deadlineAt),
    inspected.entriesByPath
  );
  return {
    ...inspected,
    close: () => {},
    read: (path: string, remaining: number) => {
      const entry = entries.get(path),
        metadata = inspected.entriesByPath.get(path);
      if (!entry || !metadata) throw invalidArchive(`missing path "${path}"`);
      return readEntryContent(
        entry,
        path,
        metadata.uncompressedSize,
        limits.maxEntryBytes,
        remaining,
        deadlineAt
      );
    },
  };
};

export async function* streamSourceArchive(
  archiveBytes: Uint8Array | string,
  limits: SourceArchiveLimits
): AsyncGenerator<SourceArchiveEntry> {
  validateLimits(limits);
  const deadlineAt = Date.now() + PROJECT_SOURCE_ARCHIVE_PDF_POLICY.archivePreparationTimeoutMs;
  const archive = await openArchiveContent(archiveBytes, limits, deadlineAt);
  try {
    const { entriesByPath, totalExpandedBytes: originalTotalExpandedBytes } = archive;
    const directories = new Map<string, SourceArchiveDirectoryEntry>();
    const filePaths: string[] = [];

    for (const [path, metadata] of entriesByPath) {
      addParentDirectories(directories, path);
      if (metadata.directory) {
        directories.set(path, {
          explicit: true,
          kind: 'directory',
          path,
        });
        continue;
      }
      filePaths.push(path);
    }

    const orderedEntries: Array<SourceArchiveDirectoryEntry | { kind: 'file'; path: string }> = [
      ...directories.values(),
      ...filePaths.map(path => ({ kind: 'file' as const, path })),
    ].sort(compareEntryPaths);
    let actualExpandedBytes = 0;
    let preparedExpandedBytes = 0;
    const pdfBudget: PdfPreparationBudget = {
      deadlineAt,
    };
    for (const entry of orderedEntries) {
      if (Date.now() >= deadlineAt) throw invalidArchive('preparation deadline exceeded');
      if (entry.kind === 'directory') {
        yield entry;
        continue;
      }
      const path = entry.path;
      const content = await archive.read(path, limits.maxExpandedBytes - actualExpandedBytes);
      actualExpandedBytes += content.byteLength;

      const text = decodeUtf8(content);
      const sourceEntry: SourceArchiveFileEntry = {
        byteSize: content.byteLength,
        content,
        hash: createHash('sha256').update(content).digest('hex'),
        kind: 'file',
        path,
        ...(text === undefined
          ? {}
          : {
              preview: createSourceArchivePreview(text),
              text,
            }),
      };
      const remainingOriginalBytes = originalTotalExpandedBytes - actualExpandedBytes;
      const remainingPreparedBytes =
        limits.maxExpandedBytes - preparedExpandedBytes - remainingOriginalBytes;
      const preparedEntry = await prepareSourceArchiveFile(
        sourceEntry,
        Math.min(limits.maxEntryBytes, remainingPreparedBytes),
        pdfBudget
      );
      preparedExpandedBytes += preparedEntry.byteSize;
      yield preparedEntry;
    }
  } finally {
    archive.close();
  }
}

export const indexSourceArchive = async (
  archiveBytes: Uint8Array,
  limits: SourceArchiveLimits
): Promise<SourceArchiveIndex> => {
  const entries: SourceArchiveEntry[] = [];
  let fileCount = 0;
  let totalExpandedBytes = 0;
  for await (const entry of streamSourceArchive(archiveBytes, limits)) {
    entries.push(entry);
    if (entry.kind === 'file') {
      fileCount += 1;
      totalExpandedBytes += entry.byteSize;
    }
  }
  return {
    entries,
    fileCount,
    totalExpandedBytes,
  };
};
