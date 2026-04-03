import type { CodebaseBundleSource, FileData, ProjectSource } from '../../types';

const TEXT_FILE_EXTENSION_TO_MIME = new Map<string, string>([
  ['cfg', 'text/plain'],
  ['conf', 'text/plain'],
  ['csv', 'text/csv'],
  ['htm', 'text/html'],
  ['html', 'text/html'],
  ['ini', 'text/plain'],
  ['json', 'application/json'],
  ['jsonl', 'application/json'],
  ['log', 'text/plain'],
  ['markdown', 'text/markdown'],
  ['md', 'text/markdown'],
  ['mdx', 'text/markdown'],
  ['text', 'text/plain'],
  ['toml', 'application/toml'],
  ['txt', 'text/plain'],
  ['xml', 'application/xml'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
]);

const LIKELY_TEXT_FILE_EXTENSIONS = new Set<string>([
  ...TEXT_FILE_EXTENSION_TO_MIME.keys(),
  'bash',
  'bat',
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'cxx',
  'go',
  'h',
  'hpp',
  'java',
  'js',
  'jsx',
  'less',
  'lua',
  'mjs',
  'py',
  'rb',
  'rs',
  'sass',
  'scss',
  'sh',
  'sql',
  'svg',
  'ts',
  'tsx',
]);

const KNOWN_TEXT_MIME_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-javascript',
  'application/x-sh',
  'application/x-typescript',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
  'image/svg+xml',
]);

const ZIP_MIME_TYPES = new Set([
  'application/x-zip',
  'application/x-zip-compressed',
  'application/zip',
  'multipart/x-zip',
]);

const bytesToBinaryString = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return binary;
};

const binaryStringToBytes = (binary: string): Uint8Array =>
  Uint8Array.from(binary, char => char.charCodeAt(0));

const normalizeMimeType = (mimeType: string): string =>
  mimeType.split(';', 1)[0]?.trim().toLowerCase() || '';

const getFileExtension = (name: string): string => {
  const lastDotIndex = name.lastIndexOf('.');
  return lastDotIndex >= 0 ? name.slice(lastDotIndex + 1).toLowerCase() : '';
};

const inferTextMimeTypeFromName = (name: string): string => {
  const extension = getFileExtension(name);
  if (!extension) {
    return '';
  }

  return TEXT_FILE_EXTENSION_TO_MIME.get(extension) || (LIKELY_TEXT_FILE_EXTENSIONS.has(extension) ? 'text/plain' : '');
};

const isTextMimeType = (mimeType: string): boolean => {
  const normalizedMimeType = normalizeMimeType(mimeType);
  return (
    normalizedMimeType.startsWith('text/') ||
    normalizedMimeType.endsWith('+json') ||
    normalizedMimeType.endsWith('+xml') ||
    KNOWN_TEXT_MIME_TYPES.has(normalizedMimeType)
  );
};

const countReplacementCharacters = (text: string): number => {
  const matches = text.match(/\uFFFD/g);
  return matches ? matches.length : 0;
};

export const encodeBytesBase64 = (bytes: Uint8Array): string => {
  if (typeof btoa === 'function') {
    return btoa(bytesToBinaryString(bytes));
  }

  return Buffer.from(bytes).toString('base64');
};

export const decodeBase64Bytes = (value: string): Uint8Array => {
  if (typeof atob === 'function') {
    return binaryStringToBytes(atob(value));
  }

  return Uint8Array.from(Buffer.from(value, 'base64'));
};

export const encodeTextBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  return encodeBytesBase64(bytes);
};

export const decodeTextBase64 = (value: string): string =>
  new TextDecoder().decode(decodeBase64Bytes(value));

export const decodeTextBase64Preview = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) {
    return '';
  }

  const roundedByteBudget = Math.max(4, Math.ceil(maxBytes / 3) * 4);
  const previewBase64 = value.slice(0, roundedByteBudget);
  if (!previewBase64) {
    return '';
  }

  return new TextDecoder().decode(decodeBase64Bytes(previewBase64));
};

export const isLikelyBinaryData = (bytes: Uint8Array): boolean => {
  const checkLength = Math.min(bytes.length, 1024);
  if (checkLength === 0) {
    return false;
  }

  let suspiciousControlCount = 0;

  for (let index = 0; index < checkLength; index += 1) {
    const byte = bytes[index];
    if (byte === 0) {
      return true;
    }

    const isAllowedControlByte = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !isAllowedControlByte) {
      suspiciousControlCount += 1;
    }
  }

  if (suspiciousControlCount / checkLength > 0.1) {
    return true;
  }

  const preview = new TextDecoder().decode(bytes.subarray(0, checkLength));
  const replacementRatio = countReplacementCharacters(preview) / Math.max(preview.length, 1);
  return replacementRatio > 0.05;
};

export type SourceFileKind = 'pdf' | 'text' | 'zip' | 'unsupported';

export const isPdfFileData = (file: Pick<FileData, 'name' | 'mimeType'> | null | undefined): boolean =>
  Boolean(file && (normalizeMimeType(file.mimeType) === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')));

export const isZipFileData = (file: Pick<FileData, 'name' | 'mimeType'> | null | undefined): boolean =>
  Boolean(file && (ZIP_MIME_TYPES.has(normalizeMimeType(file.mimeType)) || file.name.toLowerCase().endsWith('.zip')));

export const detectSourceFileKind = ({
  name,
  mimeType,
  bytes,
}: {
  name: string;
  mimeType: string;
  bytes?: Uint8Array;
}): SourceFileKind => {
  if (isPdfFileData({ name, mimeType })) {
    return 'pdf';
  }

  const normalizedMimeType = normalizeMimeType(mimeType);
  const hasZipHint = ZIP_MIME_TYPES.has(normalizedMimeType) || name.toLowerCase().endsWith('.zip');
  const hasTextHint = isTextMimeType(normalizedMimeType) || Boolean(inferTextMimeTypeFromName(name));

  if (hasZipHint) {
    return hasTextHint && bytes && !isLikelyBinaryData(bytes) ? 'text' : 'zip';
  }

  if (hasTextHint) {
    return 'text';
  }

  return bytes && !isLikelyBinaryData(bytes) ? 'text' : 'unsupported';
};

export const detectStoredSourceFileKind = (file: FileData): SourceFileKind => {
  try {
    return detectSourceFileKind({
      name: file.name,
      mimeType: file.mimeType,
      bytes: decodeBase64Bytes(file.data),
    });
  } catch {
    return detectSourceFileKind({
      name: file.name,
      mimeType: file.mimeType,
    });
  }
};

export const normalizeSourceFileMimeType = (
  name: string,
  mimeType: string,
  kind: SourceFileKind
): string => {
  const normalizedMimeType = normalizeMimeType(mimeType);

  if (kind === 'pdf') {
    return 'application/pdf';
  }

  if (kind === 'zip') {
    return normalizedMimeType || 'application/zip';
  }

  if (kind === 'text') {
    if (isTextMimeType(normalizedMimeType)) {
      return normalizedMimeType;
    }

    return inferTextMimeTypeFromName(name) || 'text/plain';
  }

  return normalizedMimeType;
};

export const isTextSourceFileData = (file: FileData | null | undefined): boolean =>
  Boolean(file && detectStoredSourceFileKind(file) === 'text');

const isCodebaseArchiveSource = (source: CodebaseBundleSource): boolean =>
  source.files.length > 0 || source.name.toLowerCase().endsWith('.zip');

export const isDocumentProjectSource = (source: ProjectSource | null | undefined): boolean => {
  if (!source) {
    return false;
  }

  if (source.kind === 'pdf') {
    return true;
  }

  return !isCodebaseArchiveSource(source);
};

export const createProjectSourceFromFile = (file: FileData): ProjectSource => {
  if (isPdfFileData(file)) {
    return { kind: 'pdf', file };
  }

  const aggregatedText = decodeTextBase64(file.data);
  return {
    kind: 'codebase-bundle',
    name: file.name,
    aggregatedText,
    files: [],
    stats: {
      includedFileCount: 0,
      skippedFileCount: 0,
      truncatedFileCount: 0,
      totalCharacterCount: aggregatedText.length,
    },
  };
};

export const getProjectSourceFile = (source: ProjectSource | null | undefined): FileData | null => {
  if (!source) {
    return null;
  }

  if (source.kind === 'pdf') {
    return source.file;
  }

  return {
    name: source.name,
    mimeType: normalizeSourceFileMimeType(source.name, '', 'text'),
    data: encodeTextBase64(source.aggregatedText),
  };
};

export const getProjectSourceName = (source: ProjectSource | null | undefined): string => {
  if (!source) {
    return '';
  }

  return source.kind === 'pdf' ? source.file.name : source.name;
};

export const createLegacyCodebaseSource = (name: string, aggregatedText: string): CodebaseBundleSource => ({
  kind: 'codebase-bundle',
  name,
  aggregatedText,
  files: [],
  stats: {
    includedFileCount: 0,
    skippedFileCount: 0,
    truncatedFileCount: 0,
    totalCharacterCount: aggregatedText.length,
  },
});
