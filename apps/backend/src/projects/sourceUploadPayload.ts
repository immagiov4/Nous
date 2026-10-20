import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { ProjectImportInputError } from './projectImportChunks.js';

/** Reads the snapshot prefix independently of the original source files on disk. */
export const readSourceUploadMetadata = async (path: string, metadataBytes: unknown) => {
  if (
    !Number.isSafeInteger(metadataBytes) ||
    (metadataBytes as number) <= 0 ||
    (metadataBytes as number) > (await stat(path)).size
  )
    throw new ProjectImportInputError('Metadati delle fonti non validi.');
  let serialized = '';
  for await (const chunk of createReadStream(path, {
    start: 0,
    end: (metadataBytes as number) - 1,
    encoding: 'utf8',
  }))
    serialized += chunk;
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new ProjectImportInputError('Metadati delle fonti non validi.');
  }
};
