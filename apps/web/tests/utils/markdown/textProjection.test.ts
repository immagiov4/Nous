import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildVisibleProjection,
  trimSegmentWhitespace,
} from '../../../utils/markdown/textProjection.ts';

test('buildVisibleProjection skips closing parentheses inside quoted link titles', () => {
  const projection = buildVisibleProjection(
    'Prima [un link](https://example.com "Titolo con ) parentesi") dopo.'
  );

  assert.equal(projection.text, 'Prima un link dopo.');
});

test('buildVisibleProjection excludes inline quiz markers while preserving source indexes', () => {
  const content = [
    'Prima spiegazione.',
    '',
    '{{INLINE_QUIZ:0}}',
    '',
    'Seconda spiegazione.',
    '',
    '{{VISUAL_EXAMPLE:slot-001}}',
  ].join('\n');
  const projection = buildVisibleProjection(content);
  const secondParagraphOffset = content.indexOf('Seconda spiegazione.');
  const projectedSecondParagraphOffset = projection.text.indexOf('Seconda spiegazione.');

  assert.doesNotMatch(projection.text, /INLINE|QUIZ|VISUAL|slot-001/);
  assert.equal(projection.sourceIndexes[projectedSecondParagraphOffset], secondParagraphOffset);
});

test('buildVisibleProjection hides reference image alt text and link destinations', () => {
  const projection = buildVisibleProjection(
    '![Schema nascosto][schema] Testo [visibile](https://example.com/nascosto).\n\n[schema]: image.png'
  );

  assert.doesNotMatch(projection.text, /Schema nascosto|example|nascosto|image\.png|schema:/i);
  assert.match(projection.text, /Testo visibile/);
});

test('buildVisibleProjection hides full and collapsed reference labels', () => {
  const content = [
    '[Testo pieno][destinazione]',
    '[Testo collassato][]',
    '',
    '[destinazione]: /full',
    '[Testo collassato]: /collapsed',
  ].join('\n');

  assert.equal(buildVisibleProjection(content).text.trim(), 'Testo pieno\nTesto collassato');
});

test('buildVisibleProjection preserves reference-like text inside raw html containers', () => {
  const content = '<div>\n[Testo][ref]\n</div>\n\n[ref]: /hidden';

  assert.match(buildVisibleProjection(content).text, /Testoref/u);
});

test('buildVisibleProjection follows rendered footnote, autolink, and list-definition visibility', () => {
  const content = [
    'Testo[^nota] e <https://example.com>.',
    '',
    '[^nota]: Contenuto della nota.',
    '',
    '- [ref]:',
    '    /image.png',
    '',
    '  ![Immagine][ref]',
  ].join('\n');
  const projection = buildVisibleProjection(content);
  const footnoteReferenceStart = content.indexOf('[^nota]');

  assert.match(projection.text, /Contenuto della nota/u);
  assert.match(projection.text, /https:\/\/example\.com/u);
  assert.doesNotMatch(projection.text, /image\.png|Immagine/u);
  assert.equal(
    projection.sourceIndexes.some(
      sourceIndex =>
        sourceIndex >= footnoteReferenceStart && sourceIndex < footnoteReferenceStart + 7
    ),
    false
  );
});

test('buildVisibleProjection preserves malformed email autolink brackets', () => {
  assert.match(buildVisibleProjection('<a@b>').text, /<a@b>/u);
  assert.equal(buildVisibleProjection('<https://example.com>').text, '<https://example.com>');
});

test('buildVisibleProjection hides supported mark syntax but preserves escaped raw html', () => {
  assert.equal(buildVisibleProjection('<mark>visibile</mark>').text, 'visibile');
  assert.match(buildVisibleProjection('<div>visibile</div>').text, /<div>visibile<\/div>/u);
});

test('buildVisibleProjection follows renderer-normalized prose indentation and backslash math', () => {
  const content = String.raw`    Frase visibile con \(x + y\).`;

  assert.equal(buildVisibleProjection(content).text, 'Frase visibile con x + y.');
});

test('buildVisibleProjection keeps the longest hidden range when starts collide', () => {
  assert.equal(buildVisibleProjection('\t[ref]: /image.png').text, '');
});

test('buildVisibleProjection keeps adjacent backslash math expressions separate', () => {
  assert.equal(buildVisibleProjection(String.raw`\(x\)\(y\)`).text, 'xy');
});

test('buildVisibleProjection omits non-text block syntax', () => {
  const content = ['---', '', '| Header |', '| --- |', '| Value |'].join('\n');
  const projection = buildVisibleProjection(content).text;

  assert.doesNotMatch(projection, /---/u);
  assert.match(projection, /Header/u);
  assert.match(projection, /Value/u);
});

test('buildVisibleProjection projects backslash math inside escaped raw html', () => {
  assert.equal(
    buildVisibleProjection(String.raw`<span>\(visible\)</span>`).text,
    '<span>visible</span>'
  );
});

test('buildVisibleProjection preserves malformed image syntax rendered as text', () => {
  const projection = buildVisibleProjection('![testo visibile](destinazione non valida)');

  assert.match(projection.text, /testo visibile/);
});

test('buildVisibleProjection preserves malformed definitions and hides multiline definitions', () => {
  const malformed = buildVisibleProjection('[ref]: destinazione non valida');
  const valid = buildVisibleProjection('[ref]: /image.png\n  "Titolo nascosto"');

  assert.match(malformed.text, /destinazione non valida/);
  assert.equal(valid.text, '');
});

test('trimSegmentWhitespace trims source ranges without changing inner text', () => {
  const content = 'Intro\n\n  testo da segnare\t\n\nFine';
  const segment = trimSegmentWhitespace(content, { start: 7, end: 27 });

  assert.deepEqual(segment, { start: 9, end: 25 });
  assert.equal(segment ? content.slice(segment.start, segment.end) : '', 'testo da segnare');
});

test('trimSegmentWhitespace returns null for whitespace-only ranges', () => {
  assert.equal(trimSegmentWhitespace('A\n \t\nB', { start: 1, end: 5 }), null);
});
