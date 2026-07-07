import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  getMarkdownProtectedRanges,
  normalizeMathSelectionArtifacts,
} from '../../../utils/markdown/codeRanges.ts';

test('normalizeMathSelectionArtifacts projects repeated math-like selection artifacts without regex scanning', () => {
  const normalized = normalizeMathSelectionArtifacts(
    'Ridurre TclusterT_{\\text{cluster}}Tcluster e TupdateT_{\\text{update}}Tupdate accelera.'
  );

  assert.equal(normalized, 'Ridurre Tcluster e Tupdate accelera.');
});

test('getMarkdownProtectedRanges keeps code fences, inline code, and math blocks protected', () => {
  const content = [
    'Testo introduttivo.',
    '`inline` e $x_{\\text{foo}}$',
    '```ts',
    'const value = 1;',
    '```',
  ].join('\n');

  const protectedRanges = getMarkdownProtectedRanges(content);
  const protectedSlices = protectedRanges.map(range => content.slice(range.start, range.end));

  assert.ok(protectedSlices.includes('`inline`'));
  assert.ok(protectedSlices.includes('$x_{\\text{foo}}$'));
  assert.ok(protectedSlices.some(slice => slice.includes('const value = 1;')));
});
