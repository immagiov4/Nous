import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeTextBase64 } from '../../services/projectSource.ts';
import { readSourceFileData } from './controllerContext.ts';

test('readSourceFileData accepts markdown uploads with missing mime type', async () => {
  const file = new File(['# Titolo\n\nContenuto'], 'notes.md');

  const result = await readSourceFileData(file);

  assert.equal(result.name, 'notes.md');
  assert.equal(result.mimeType, 'text/markdown');
  assert.equal(decodeTextBase64(result.data), '# Titolo\n\nContenuto');
});

test('readSourceFileData normalizes common text formats', async () => {
  const cases = [
    { expectedMimeType: 'application/json', file: new File(['{"ok":true}'], 'data.json') },
    { expectedMimeType: 'application/xml', file: new File(['<root />'], 'feed.xml') },
    { expectedMimeType: 'text/plain', file: new File(['started'], 'server.log') },
  ];

  for (const testCase of cases) {
    const result = await readSourceFileData(testCase.file);
    assert.equal(result.mimeType, testCase.expectedMimeType);
  }
});

test('readSourceFileData rejects unsupported binary uploads', async () => {
  const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])], 'image.bin');

  await assert.rejects(
    () => readSourceFileData(file),
    /Sono supportati PDF, ZIP o file di testo\./
  );
});
