import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  getMarkdownAnnotationProtectedRanges,
  getMarkdownProtectedRanges,
  normalizeMathSelectionArtifacts,
} from '../../../utils/markdown/codeRanges.ts';

test('normalizeMathSelectionArtifacts projects repeated math-like selection artifacts without regex scanning', () => {
  const normalized = normalizeMathSelectionArtifacts(
    'Ridurre TclusterT_{\\text{cluster}}Tcluster e TupdateT_{\\text{update}}Tupdate accelera.'
  );

  assert.equal(normalized, 'Ridurre Tcluster e Tupdate accelera.');
});

test('annotation ranges ignore malformed image openers before ordinary links', () => {
  const content = 'Spiega ![ questo testo e poi [consulta la fonte](https://example.com).';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['(https://example.com)']);
});

test('annotation ranges parse balanced parentheses in image destinations', () => {
  const content =
    'Prima ![diagramma](https://example.com/image_(large).png) e ![schema](<schema.png> ) dopo.';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, [
    '![diagramma](https://example.com/image_(large).png)',
    '![schema](<schema.png> )',
  ]);
});

test('annotation ranges keep adjacent inline code separate from an image', () => {
  const content = '![diagramma](image.png)`codice inline`';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['![diagramma](image.png)', '`codice inline`']);
});

test('annotation ranges protect reference images and ordinary link destinations', () => {
  const content = [
    '![Schema nascosto][schema]',
    '[Testo visibile](https://example.com/percorso-nascosto)',
    '',
    '[schema]: https://example.com/schema.png',
  ].join('\n');
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.ok(protectedSlices.includes('![Schema nascosto][schema]'));
  assert.ok(protectedSlices.includes('(https://example.com/percorso-nascosto)'));
});

test('annotation ranges leave renderer-visible malformed images anchorable', () => {
  const content = '![testo ancora visibile](destinazione non valida)';

  assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), []);
});

test('annotation ranges preserve malformed definitions and angle destinations', () => {
  const content = [
    '[ref]: destinazione non valida',
    '[ref]: image(non-bilanciata',
    '![alt](<destinazione non valida>)',
    '![alt](<image.png>testo)',
  ].join('\n');

  assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), []);
});

test('annotation ranges resolve escaped reference labels', () => {
  const content = '![Alt nascosto][a\\]b]\n\n[a\\]b]: image.png';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.ok(protectedSlices.includes('![Alt nascosto][a\\]b]'));
});

test('annotation ranges include complete multiline reference definitions', () => {
  const content = '[ref]: /image.png\n  "Titolo nascosto"';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, [content]);
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
