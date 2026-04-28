import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildCodebaseBundleSource, isBinaryFile } from '../../../utils/project/codebaseBundle.ts';

test('buildCodebaseBundleSource sorts files deterministically and keeps stable aggregated text', () => {
  const bundle = buildCodebaseBundleSource('repo.zip', [
    { path: 'src/zeta.ts', text: 'export const zeta = 1;' },
    { path: 'src/alpha.ts', text: 'export const alpha = 1;' },
  ]);

  assert.deepEqual(
    bundle.files.map(file => file.path),
    ['src/alpha.ts', 'src/zeta.ts']
  );
  assert.match(bundle.aggregatedText, /START OF FILE: src\/alpha\.ts/);
  assert.match(bundle.aggregatedText, /START OF FILE: src\/zeta\.ts/);
  assert.equal(bundle.stats.includedFileCount, 2);
});

test('buildCodebaseBundleSource applies explicit truncation budgets and tracks stats', () => {
  const bundle = buildCodebaseBundleSource(
    'repo.zip',
    [
      { path: 'src/a.ts', text: 'a'.repeat(80) },
      { path: 'src/b.ts', text: '' },
    ],
    { maxFileChars: 20, maxTotalChars: 25 }
  );

  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.files[0].truncated, true);
  assert.match(bundle.files[0].text, /\[TRUNCATED FOR CONTEXT BUDGET\]/);
  assert.equal(bundle.stats.truncatedFileCount, 1);
  assert.equal(bundle.stats.skippedFileCount, 1);
});

test('isBinaryFile detects null bytes early', () => {
  assert.equal(isBinaryFile(new Uint8Array([65, 0, 66])), true);
  assert.equal(isBinaryFile(new Uint8Array([65, 66, 67])), false);
});
