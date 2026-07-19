import type { SourceArchiveProjectSource } from '../../types.ts';

export const isBinaryFile = (bytes: Uint8Array): boolean => decodeText(bytes) === undefined;

const decodeText = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

export const createSourceArchiveFromZip = async (
  file: File
): Promise<SourceArchiveProjectSource> => {
  return {
    file: {
      data: '',
      mimeType: file.type || 'application/zip',
      name: file.name,
    },
    index: {
      entries: [],
    },
    kind: 'archive',
    name: file.name,
  };
};
