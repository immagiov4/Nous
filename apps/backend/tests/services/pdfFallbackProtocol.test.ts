import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { buildPdfPageFixture } from '../fixtures/pdfText.js';

test('the isolated worker emits a portable JSON response instead of runtime-specific serialization', () => {
  const bytes = buildPdfPageFixture(['BT /F1 12 Tf 10 100 Td (ABC) Tj ET'], 'Symbol');
  const worker = fileURLToPath(
    new URL('../../src/services/pdfTextFallbackProcess.mjs', import.meta.url)
  );
  const result = spawnSync('node', [worker, 'text', '1000000'], { input: bytes });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.toString('utf8'))).toMatchObject({
    pages: [{ pageNumber: 1, text: 'ΑΒΧ' }],
  });
});
