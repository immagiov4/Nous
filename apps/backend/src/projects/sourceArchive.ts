import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { createSourceArchivePreview } from '@shared/sourceArchivePreview';
import JSZip from 'jszip';
import { extractPdfText } from '../services/pdfTextExtractor.js';
import { encodePdfDataUrl } from '../utils/pdfDataUrl.js';

export interface SourceArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
}

export const PROJECT_SOURCE_ARCHIVE_LIMITS: SourceArchiveLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 256_000_000,
  maxExpandedBytes: 1_000_000_000,
};

export const PROJECT_SOURCE_ARCHIVE_MAX_COMPRESSED_BYTES = 256_000_000;

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

const invalidArchive = (reason: string) => new Error(`Invalid source archive: ${reason}.`);

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

    const loadedSize = loadedEntry._data?.uncompressedSize;
    // JSZip represents empty entries as promises publicly; their central metadata remains exact.
    if (loadedSize === undefined && metadata.uncompressedSize === 0) {
      continue;
    }
    if (typeof loadedSize !== 'number' || !Number.isSafeInteger(loadedSize) || loadedSize < 0) {
      throw invalidArchive('missing uncompressed size metadata');
    }
    if (loadedSize !== metadata.uncompressedSize) {
      throw invalidArchive(`inconsistent uncompressed size for "${path}"`);
    }
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
  remainingExpandedBytes: number
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const content = new Uint8Array(expectedSize);
    const stream = loadedEntry.internalStream('uint8array');
    let offset = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      stream.pause();
      reject(error);
    };

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
        resolve(content);
      })
      .resume();
  });

const compareEntryPaths = (
  left: Pick<SourceArchiveEntry, 'path'>,
  right: Pick<SourceArchiveEntry, 'path'>
) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

const isPdfArchivePath = (path: string): boolean => path.toLowerCase().endsWith('.pdf');

const toBinarySourceArchiveFile = (entry: SourceArchiveFileEntry): SourceArchiveFileEntry => ({
  byteSize: entry.byteSize,
  content: entry.content,
  hash: entry.hash,
  kind: 'file',
  path: entry.path,
});

const prepareSourceArchiveFile = async (
  entry: SourceArchiveFileEntry,
  maxPreparedBytes: number
): Promise<SourceArchiveFileEntry> => {
  if (!isPdfArchivePath(entry.path)) {
    return entry;
  }

  try {
    const extractedText = (await extractPdfText(encodePdfDataUrl(entry.content))).text.trim();
    if (extractedText) {
      const content = new TextEncoder().encode(extractedText);
      if (content.byteLength > maxPreparedBytes) {
        console.warn('[Backend] Extracted PDF text exceeds source archive limits.', {
          path: entry.path,
        });
        return toBinarySourceArchiveFile(entry);
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
  }

  return toBinarySourceArchiveFile(entry);
};

export async function* streamSourceArchive(
  archiveBytes: Uint8Array,
  limits: SourceArchiveLimits
): AsyncGenerator<SourceArchiveEntry> {
  validateLimits(limits);
  const centralEntries = parseCentralDirectory(archiveBytes);
  const { entriesByPath, totalExpandedBytes: originalTotalExpandedBytes } = inspectCentralDirectory(
    centralEntries,
    limits
  );
  const loadedArchive = await loadArchive(archiveBytes);
  const loadedEntriesByPath = mapLoadedEntries(loadedArchive, entriesByPath);
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
  for (const entry of orderedEntries) {
    if (entry.kind === 'directory') {
      yield entry;
      continue;
    }
    const metadata = entriesByPath.get(entry.path);
    const path = entry.path;
    const loadedEntry = loadedEntriesByPath.get(path);
    if (!metadata || !loadedEntry) {
      throw invalidArchive(`missing path "${path}"`);
    }

    const content = await readEntryContent(
      loadedEntry,
      path,
      metadata.uncompressedSize,
      limits.maxEntryBytes,
      limits.maxExpandedBytes - actualExpandedBytes
    );
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
      Math.min(limits.maxEntryBytes, remainingPreparedBytes)
    );
    preparedExpandedBytes += preparedEntry.byteSize;
    yield preparedEntry;
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
