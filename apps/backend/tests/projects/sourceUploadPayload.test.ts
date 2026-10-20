import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_TRANSFER_LIMITS } from '@shared/sourceTransfer';
import { expect, test } from 'vitest';
import { readSourceUploadMetadata } from '../../src/projects/sourceUploadPayload';

test('rejects metadata one byte over the shared part cap before filesystem access', async () => {
  await expect(
    readSourceUploadMetadata('must-not-be-read', SOURCE_TRANSFER_LIMITS.maxPartBytes + 1)
  ).rejects.toThrow('I metadati delle fonti superano il limite di caricamento.');
});

test('reads only the UTF-8 metadata prefix and leaves original bytes on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-metadata-'));
  try {
    const prefix = Buffer.from(
      JSON.stringify({ snapshot: { title: '∀ sources' }, sourceFiles: [] })
    );
    const path = join(directory, 'upload');
    await writeFile(path, Buffer.concat([prefix, Buffer.from('original bytes')]));
    expect(await readSourceUploadMetadata(path, prefix.length)).toEqual({
      snapshot: { title: '∀ sources' },
      sourceFiles: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
