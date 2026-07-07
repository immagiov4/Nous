import JSZip from 'jszip';

const DEFAULT_MAX_ZIP_ENTRIES = 1_000;
const DEFAULT_MAX_ZIP_ENTRY_NAME_CHARS = 512;
const DEFAULT_INVALID_ARCHIVE_MESSAGE = 'Invalid ZIP archive.';

export interface SafeZipLoadOptions {
  invalidArchiveMessage?: string;
  maxEntries?: number;
  maxEntryNameChars?: number;
}

type ZipLoadInput = Parameters<typeof JSZip.loadAsync>[0];

const getInvalidArchiveMessage = (options: SafeZipLoadOptions): string =>
  options.invalidArchiveMessage ?? DEFAULT_INVALID_ARCHIVE_MESSAGE;

const isAsciiLetter = (value: string | undefined): boolean =>
  value !== undefined && ((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z'));

const hasWindowsDrivePrefix = (path: string): boolean =>
  path.length >= 2 && isAsciiLetter(path[0]) && path[1] === ':';

export const isSafeZipEntryPath = (path: string): boolean => {
  if (!path || path.startsWith('/') || path.startsWith('\\') || hasWindowsDrivePrefix(path)) {
    return false;
  }

  if (path.includes('\\')) {
    return false;
  }

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

export const loadZipSafely = async (
  data: ZipLoadInput,
  options: SafeZipLoadOptions = {}
): Promise<JSZip> => {
  const zip = await JSZip.loadAsync(data, { checkCRC32: true });
  const entries = Object.values(zip.files);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ZIP_ENTRIES;
  const maxEntryNameChars = options.maxEntryNameChars ?? DEFAULT_MAX_ZIP_ENTRY_NAME_CHARS;
  const invalidArchiveMessage = getInvalidArchiveMessage(options);

  if (entries.length > maxEntries) {
    throw new Error(invalidArchiveMessage);
  }

  entries.forEach(entry => {
    const safePath = getSafeZipEntryPath(entry);
    if (!safePath || safePath.length > maxEntryNameChars) {
      throw new Error(invalidArchiveMessage);
    }
  });

  return zip;
};

export const readZipEntryBytesWithinLimit = async (
  entry: JSZip.JSZipObject,
  maxBytes: number,
  invalidArchiveMessage = DEFAULT_INVALID_ARCHIVE_MESSAGE
): Promise<Uint8Array> => {
  const bytes = await entry.async('uint8array');
  if (bytes.length > maxBytes) {
    throw new Error(invalidArchiveMessage);
  }

  return bytes;
};

export const readZipEntryTextWithinLimit = async (
  entry: JSZip.JSZipObject,
  maxBytes: number,
  invalidArchiveMessage = DEFAULT_INVALID_ARCHIVE_MESSAGE
): Promise<string> => {
  const bytes = await readZipEntryBytesWithinLimit(entry, maxBytes, invalidArchiveMessage);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};
