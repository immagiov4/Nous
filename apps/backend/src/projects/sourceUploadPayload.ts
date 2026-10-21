import { open, stat } from 'node:fs/promises';
import { SOURCE_UPLOAD_METADATA_TOO_LARGE_MESSAGE } from '@shared/courseSourceUpload';
import { SOURCE_TRANSFER_LIMITS } from '@shared/sourceTransfer';
import { ProjectImportInputError } from './projectImportChunks.js';

/** Reads the snapshot prefix independently of the original source files on disk. */
export const readSourceUploadMetadata = async (
  input: string | readonly string[],
  metadataBytes: unknown
) => {
  if (typeof metadataBytes === 'number' && metadataBytes > SOURCE_TRANSFER_LIMITS.maxPartBytes)
    throw new ProjectImportInputError(SOURCE_UPLOAD_METADATA_TOO_LARGE_MESSAGE);
  if (!Number.isSafeInteger(metadataBytes) || (metadataBytes as number) <= 0)
    throw new ProjectImportInputError('Metadati delle fonti non validi.');
  const paths = typeof input === 'string' ? [input] : input;
  const sizes = await Promise.all(paths.map(async path => (await stat(path)).size));
  if ((metadataBytes as number) > sizes.reduce((total, size) => total + size, 0))
    throw new ProjectImportInputError('Metadati delle fonti non validi.');
  const bytes = Buffer.alloc(metadataBytes as number);
  let offset = 0;
  for (const [index, path] of paths.entries()) {
    if (offset === bytes.length) break;
    const handle = await open(path, 'r');
    const end = Math.min(bytes.length, offset + sizes[index]);
    let position = 0;
    try {
      while (offset < end) {
        const read = await handle.read(bytes, offset, end - offset, position);
        if (!read.bytesRead) throw new ProjectImportInputError('Metadati delle fonti non validi.');
        offset += read.bytesRead;
        position += read.bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
  const serialized = bytes.toString('utf8');
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new ProjectImportInputError('Metadati delle fonti non validi.');
  }
};
