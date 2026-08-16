import JSZip from 'jszip';

const DEFAULT_MAX_ZIP_ENTRIES = 1_000;
const DEFAULT_MAX_ZIP_ENTRY_NAME_CHARS = 512;
const DEFAULT_INVALID_ARCHIVE_MESSAGE = 'Invalid ZIP archive.';

export class ZipEntryTooLargeError extends Error {
  constructor(message = DEFAULT_INVALID_ARCHIVE_MESSAGE) {
    super(message);
    this.name = 'ZipEntryTooLargeError';
  }
}

export interface SafeZipLoadOptions {
  invalidArchiveMessage?: string;
  maxEntries?: number;
  maxEntryNameChars?: number;
  maxTotalUncompressedBytes?: number;
}

type ZipLoadInput = Parameters<typeof JSZip.loadAsync>[0];

interface ZipEntryWithMetadata extends JSZip.JSZipObject {
  _data?: { crc32?: number; uncompressedSize?: number };
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

const isAsciiLetter = (value: string | undefined): boolean =>
  value !== undefined && ((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z'));

const hasWindowsDrivePrefix = (path: string): boolean =>
  path.length >= 2 && isAsciiLetter(path[0]) && path[1] === ':';

export const isSafeZipEntryPath = (path: string): boolean => {
  if (!path || path.startsWith('/') || path.startsWith('\\') || hasWindowsDrivePrefix(path)) {
    return false;
  }
  if (path.includes('\\')) return false;
  const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;
  return normalizedPath.split('/').every(part => part !== '' && part !== '.' && part !== '..');
};

export const getSafeZipEntryPath = (entry: JSZip.JSZipObject): string | undefined => {
  const unsafeOriginalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string })
    .unsafeOriginalName;
  const originalPath = unsafeOriginalName ?? entry.name;
  return isSafeZipEntryPath(originalPath) && isSafeZipEntryPath(entry.name)
    ? entry.name
    : undefined;
};

const readDeclaredUncompressedSize = (
  entry: JSZip.JSZipObject,
  invalidArchiveMessage: string
): number => {
  if (entry.dir) return 0;
  const size = (entry as ZipEntryWithMetadata)._data?.uncompressedSize;
  // JSZip represents empty files with a resolved promise instead of compressed metadata.
  if (size === undefined) return 0;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(invalidArchiveMessage);
  return size;
};

export const getZipTotalUncompressedBytes = (
  zip: JSZip,
  invalidArchiveMessage = DEFAULT_INVALID_ARCHIVE_MESSAGE
): number => {
  let totalUncompressedBytes = 0;
  for (const entry of Object.values(zip.files)) {
    totalUncompressedBytes += readDeclaredUncompressedSize(entry, invalidArchiveMessage);
    if (!Number.isSafeInteger(totalUncompressedBytes)) throw new Error(invalidArchiveMessage);
  }
  return totalUncompressedBytes;
};

const updateCrc32 = (crc: number, bytes: Uint8Array): number => {
  let next = crc;
  for (const byte of bytes) {
    next = Number(CRC32_TABLE[(next ^ byte) & 0xff]) ^ (next >>> 8);
  }
  return next;
};

export const loadZipSafely = async (
  data: ZipLoadInput,
  options: SafeZipLoadOptions = {}
): Promise<JSZip> => {
  // JSZip's CRC option expands every entry while loading. Entries are streamed and bounded below.
  const zip = await JSZip.loadAsync(data, { checkCRC32: false });
  const entries = Object.values(zip.files);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ZIP_ENTRIES;
  const maxEntryNameChars = options.maxEntryNameChars ?? DEFAULT_MAX_ZIP_ENTRY_NAME_CHARS;
  const invalidArchiveMessage = options.invalidArchiveMessage ?? DEFAULT_INVALID_ARCHIVE_MESSAGE;
  if (entries.length > maxEntries) throw new Error(invalidArchiveMessage);
  for (const entry of entries) {
    const safePath = getSafeZipEntryPath(entry);
    if (!safePath || safePath.length > maxEntryNameChars) throw new Error(invalidArchiveMessage);
    readDeclaredUncompressedSize(entry, invalidArchiveMessage);
  }
  if (
    options.maxTotalUncompressedBytes !== undefined &&
    getZipTotalUncompressedBytes(zip, invalidArchiveMessage) > options.maxTotalUncompressedBytes
  ) {
    throw new Error(invalidArchiveMessage);
  }
  return zip;
};

export const readZipEntryBytesWithinLimit = async (
  entry: JSZip.JSZipObject,
  maxBytes: number,
  invalidArchiveMessage = DEFAULT_INVALID_ARCHIVE_MESSAGE
): Promise<Uint8Array> => {
  if (readDeclaredUncompressedSize(entry, invalidArchiveMessage) > maxBytes) {
    throw new ZipEntryTooLargeError(invalidArchiveMessage);
  }

  const stream = (entry as ZipEntryWithMetadata).internalStream('uint8array');
  const expectedCrc32 = (entry as ZipEntryWithMetadata)._data?.crc32;
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let crc32 = 0xffffffff;
    let settled = false;

    const rejectEntry = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };

    const rejectInvalidArchive = () => rejectEntry(new Error(invalidArchiveMessage));
    stream
      .on('data', chunk => {
        if (settled) return;
        if (chunk.byteLength > maxBytes - byteLength) {
          rejectInvalidArchive();
          return;
        }
        chunks.push(chunk);
        byteLength += chunk.byteLength;
        crc32 = updateCrc32(crc32, chunk);
      })
      .on('error', rejectInvalidArchive)
      .on('end', () => {
        if (settled) return;
        if (expectedCrc32 !== undefined && (crc32 ^ 0xffffffff) !== expectedCrc32) {
          rejectInvalidArchive();
          return;
        }
        settled = true;
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(bytes);
      })
      .resume();
  });
};

export const readZipEntryTextWithinLimit = async (
  entry: JSZip.JSZipObject,
  maxBytes: number,
  invalidArchiveMessage = DEFAULT_INVALID_ARCHIVE_MESSAGE
): Promise<string> =>
  new TextDecoder('utf-8', { fatal: true }).decode(
    await readZipEntryBytesWithinLimit(entry, maxBytes, invalidArchiveMessage)
  );
