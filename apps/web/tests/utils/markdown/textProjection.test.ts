import assert from 'node:assert/strict';
import { expect, test } from 'vitest';

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

test('buildVisibleProjection preserves incomplete placeholder-like text', () => {
  const content = 'Testo prima {{VISUAL_SLOT:bozza testo dopo';
  const projection = buildVisibleProjection(content);

  expect(projection.text).toMatch(/bozza testo dopo/u);
  assert.equal(projection.sourceIndexes.at(-1), content.length - 1);
});

test('buildVisibleProjection hides closed placeholders with whitespace payloads', () => {
  const projection = buildVisibleProjection('Prima {{VISUAL_SLOT:   }} dopo').text;

  expect(projection).not.toMatch(/VISUAL_SLOT/u);
  assert.match(projection, /Prima\s+dopo/u);
});

test('buildVisibleProjection preserves a malformed marker before a complete marker', () => {
  const projection = buildVisibleProjection(
    'Prima {{VISUAL_SLOT:bozza poi {{VISUAL_SLOT:slot-1}} dopo'
  ).text;

  expect(projection).toMatch(/bozza poi/u);
  assert.doesNotMatch(projection, /slot-1/u);
});

test('buildVisibleProjection preserves a malformed PDF marker before a complete marker', () => {
  const projection = buildVisibleProjection(
    'Prima {{PDF_IMAGE:bozza poi {{PDF_IMAGE:asset-1}} dopo'
  ).text;

  expect(projection).toMatch(/bozza poi/u);
  assert.doesNotMatch(projection, /asset-1/u);
});

test('buildVisibleProjection preserves placeholders with unknown options', () => {
  const projection = buildVisibleProjection('Prima {{PDF_IMAGE:asset-1|foo=bar}} dopo').text;

  expect(projection).toMatch(/foo=bar/u);
});

test('buildVisibleProjection preserves complete placeholders shown as inline code', () => {
  const projection = buildVisibleProjection('Mostra `{{INLINE_QUIZ:0}}` come sintassi.');

  expect(projection.text).toBe('Mostra {{INLINE_QUIZ:0}} come sintassi.');
});

test('buildVisibleProjection hides inline-code placeholders consumed by media renderers', () => {
  const projection = buildVisibleProjection(
    'Mostra `{{PDF_IMAGE:missing}}` e `{{VISUAL_SLOT:slot-1}}` come sintassi.'
  );

  expect(projection.text).toBe('Mostra  e  come sintassi.');
});

test('buildVisibleProjection hides reference image alt text and link destinations', () => {
  const projection = buildVisibleProjection(
    '![Schema nascosto][schema] Testo [visibile](https://example.com/nascosto).\n\n[schema]: image.png'
  );

  expect(projection.text).not.toMatch(/Schema nascosto|example|nascosto|image\.png|schema:/i);
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

  expect(buildVisibleProjection(content).text.trim()).toBe('Testo pieno\nTesto collassato');
});

test('buildVisibleProjection hides reference labels exposed by escaped raw html', () => {
  const content = '<div>\n[Testo][ref]\n</div>\n\n[ref]: /hidden';
  const projection = buildVisibleProjection(content).text;

  expect(projection).toMatch(/Testo/u);
  assert.doesNotMatch(projection, /ref/u);
});

test('buildVisibleProjection hides footnote labels exposed by escaped raw html', () => {
  const projection = buildVisibleProjection('<div>\nTesto[^nota]\n</div>\n\n[^nota]: Corpo').text;

  expect(projection).toMatch(/Testo/u);
  assert.match(projection, /Corpo/u);
  assert.doesNotMatch(projection, /\[?\^nota/u);
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

  expect(projection.text).toMatch(/Contenuto della nota/u);
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
  expect(buildVisibleProjection('<a@b>').text).toMatch(/<a@b>/u);
  assert.equal(buildVisibleProjection('<https://example.com>').text, '<https://example.com>');
});

test('buildVisibleProjection preserves lone-CR line boundaries and source indexes', () => {
  const content = 'Prima\rDopo';
  const projection = buildVisibleProjection(content);

  expect(projection.text).toBe('Prima\nDopo');
  expect(projection.sourceIndexes[5]).toBe(content.indexOf('\r'));
  expect(projection.sourceIndexes[6]).toBe(content.indexOf('Dopo'));
});

test('buildVisibleProjection decodes CommonMark character references outside code', () => {
  const content = 'A &amp; B, &#38; C, &#x26; D, &not-a-reference; e `&amp;`';
  const projection = buildVisibleProjection(content);

  expect(projection.text).toBe('A & B, & C, & D, &not-a-reference; e &amp;');
  const firstAmpersand = projection.text.indexOf('&');
  assert.equal(projection.sourceIndexes[firstAmpersand], content.indexOf('&amp;'));
  assert.equal(projection.sourceEnds[firstAmpersand], content.indexOf('&amp;') + '&amp;'.length);
});

test('buildVisibleProjection keeps UTF-16 source maps aligned for decoded astral characters', () => {
  const projection = buildVisibleProjection('Prima &#x1F600; dopo');

  expect(projection.text).toBe('Prima 😀 dopo');
  expect(projection.sourceIndexes).toHaveLength(projection.text.length);
  expect(projection.sourceEnds).toHaveLength(projection.text.length);
  expect(projection.sourceIndexes.slice(6, 8)).toStrictEqual([6, 6]);
  expect(projection.sourceEnds.slice(6, 8)).toStrictEqual([15, 15]);
});

test('buildVisibleProjection decodes references in raw html bodies but not escaped tag syntax', () => {
  expect(buildVisibleProjection('<mark>\nA &amp; B\n</mark>').text).toBe('\nA & B\n');
  assert.equal(
    buildVisibleProjection('<div title="A &amp; B">\nA &amp; B\n</div>').text,
    '<div title="A &amp; B">\nA & B\n</div>'
  );
});

test('buildVisibleProjection preserves word boundaries around hidden inline content', () => {
  expect(buildVisibleProjection('prima[^nota]dopo\n\n[^nota]: nota').text).toBe(
    'prima dopo\n\nnota'
  );
  assert.equal(buildVisibleProjection('prima![figura](image.png)dopo').text, 'prima dopo');
  assert.equal(buildVisibleProjection('prima[^nota].\n\n[^nota]: nota').text, 'prima.\n\nnota');
  assert.equal(
    buildVisibleProjection('prima[^uno][^due]dopo\n\n[^uno]: uno\n[^due]: due').text,
    'prima dopo\n\nuno\ndue'
  );
  assert.equal(buildVisibleProjection('prima![figura](image.png)**dopo**').text, 'prima dopo');
  assert.equal(buildVisibleProjection('**prima**![figura](image.png)dopo').text, 'prima dopo');
  assert.equal(
    buildVisibleProjection('prima[^nota]*dopo*\n\n[^nota]: nota').text,
    'prima dopo\n\nnota'
  );
});

test('buildVisibleProjection hides supported mark syntax but preserves escaped raw html', () => {
  expect(buildVisibleProjection('<mark>visibile</mark>').text).toBe('visibile');
  assert.equal(buildVisibleProjection('<mark title="1 > 0">visibile</mark>').text, 'visibile');
  assert.equal(buildVisibleProjection("<mark title='1 > 0'>visibile</mark>").text, 'visibile');
  assert.equal(
    buildVisibleProjection('<mark>\npassaggio visibile\n</mark>').text,
    '\npassaggio visibile\n'
  );
  assert.match(buildVisibleProjection('<div>visibile</div>').text, /<div>visibile<\/div>/u);
  assert.equal(
    buildVisibleProjection('<mark>\npassaggio <div>visibile</div>\n</mark>').text,
    '\npassaggio <div>visibile</div>\n'
  );
});

test('buildVisibleProjection hides Setext underlines but preserves their heading text', () => {
  const cases = [
    { source: 'Titolo\n===', visible: /Titolo/u },
    { source: 'Prima riga\nseconda riga\n===', visible: /Prima riga\nseconda riga/u },
    { source: '    Titolo\n    ===', visible: /Titolo/u },
    { source: '\tTitolo\n\t===', visible: /Titolo/u },
  ];

  for (const testCase of cases) {
    const projection = buildVisibleProjection(testCase.source).text;
    expect(projection).toMatch(testCase.visible);
    assert.doesNotMatch(projection, /=/u);
  }
});

test('buildVisibleProjection hides footnote definition labels but keeps their content', () => {
  expect(buildVisibleProjection('[^nota]: Contenuto della nota.').text).toBe(
    'Contenuto della nota.'
  );
});

test('buildVisibleProjection follows renderer-normalized prose indentation and backslash math', () => {
  const content = String.raw`    Frase visibile con \(x + y\).`;

  expect(buildVisibleProjection(content).text).toBe('Frase visibile con x + y.');
});

test('buildVisibleProjection keeps the longest hidden range when starts collide', () => {
  expect(buildVisibleProjection('\t[ref]: /image.png').text).toBe('');
});

test('buildVisibleProjection keeps adjacent backslash math expressions separate', () => {
  expect(buildVisibleProjection(String.raw`\(x\)\(y\)`).text).toBe('xy');
});

test('buildVisibleProjection omits non-text block syntax', () => {
  const content = ['---', '', '| Header |', '| --- |', '| Value |'].join('\n');
  const projection = buildVisibleProjection(content).text;

  expect(projection).not.toMatch(/---/u);
  assert.match(projection, /Header/u);
  assert.match(projection, /Value/u);
});

test('buildVisibleProjection projects backslash math inside escaped raw html', () => {
  expect(buildVisibleProjection(String.raw`<span>\(visible\)</span>`).text).toBe(
    '<span>visible</span>'
  );
});

test('buildVisibleProjection preserves malformed image syntax rendered as text', () => {
  const projection = buildVisibleProjection('![testo visibile](destinazione non valida)');

  expect(projection.text).toMatch(/testo visibile/);
});

test('buildVisibleProjection preserves malformed definitions and hides multiline definitions', () => {
  const malformed = buildVisibleProjection('[ref]: destinazione non valida');
  const valid = buildVisibleProjection('[ref]: /image.png\n  "Titolo nascosto"');

  expect(malformed.text).toMatch(/destinazione non valida/);
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
