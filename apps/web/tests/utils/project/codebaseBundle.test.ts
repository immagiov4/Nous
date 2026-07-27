import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createSourceArchiveFromZip } from '../../../utils/project/codebaseBundle.ts';

test('createSourceArchiveFromZip keeps archive bytes out of the browser snapshot', async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
  const file = new File([bytes as BlobPart], 'engine.zip', { type: 'application/zip' });
  const readArchiveBytes = vi.spyOn(file, 'arrayBuffer');

  const source = await createSourceArchiveFromZip(file);

  assert.equal(source.kind, 'archive');
  assert.equal(source.name, 'engine.zip');
  assert.equal(source.file.mimeType, 'application/zip');
  assert.equal(source.file.data, '');
  assert.deepEqual(source.index.entries, []);
  assert.equal(readArchiveBytes.mock.calls.length, 0);
});
