import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import {
  findInlineLinkDestinationEnd,
  getMarkdownAnnotationProtectedRanges,
  getMarkdownProtectedRanges,
  getMarkdownReferenceDefinitionRanges,
  normalizeMathSelectionArtifacts,
  parseMarkdownAnalysis,
  planMarkdownFencedCode,
  projectUnclosedMarkdownFenceOpeners,
  stripHighlightTagsInsideMarkdownCode,
} from '../../../utils/markdown/codeRanges.ts';

test('synthetic link parsing rejects a later valid destination', () => {
  const content = '(destinazione non valida) poi [valido](https://example.com)';

  expect(findInlineLinkDestinationEnd(content, 0)).toBe(-1);
});

test('normalizeMathSelectionArtifacts projects repeated math-like selection artifacts without regex scanning', () => {
  const normalized = normalizeMathSelectionArtifacts(
    'Ridurre TclusterT_{\\text{cluster}}Tcluster e TupdateT_{\\text{update}}Tupdate accelera.'
  );

  assert.equal(normalized, 'Ridurre Tcluster e Tupdate accelera.');
});

test.each([
  [
    'annotation ranges ignore malformed image openers before ordinary links',
    'Spiega ![ questo testo e poi [consulta la fonte](https://example.com).',
    ['(https://example.com)'],
  ],
  [
    'annotation ranges preserve a malformed marker before a complete marker',
    'Prima {{VISUAL_SLOT:bozza poi {{VISUAL_SLOT:slot-1}} dopo',
    ['{{VISUAL_SLOT:slot-1}}'],
  ],
  [
    'annotation ranges parse parenthesized ordinary-link titles',
    '[schema](image.png (Titolo nascosto))',
    ['(image.png (Titolo nascosto))'],
  ],
  [
    'annotation ranges protect dollar math exposed by escaped raw html',
    '<div>\n$x$\n</div>',
    ['$x$'],
  ],
] as const)('%s', (_name, content, expectedSlices) => {
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual(expectedSlices);
});

test.each([
  [
    'annotation ranges leave incomplete placeholder-like text anchorable',
    'Testo prima {{VISUAL_SLOT:bozza testo dopo',
  ],
  [
    'annotation ranges leave placeholders with unknown options anchorable',
    '{{PDF_IMAGE:asset-1|foo=bar}}',
  ],
  [
    'annotation ranges leave renderer-visible malformed images anchorable',
    '![testo ancora visibile](destinazione non valida)',
  ],
] as const)('%s', (_name, content) => {
  expect(getMarkdownAnnotationProtectedRanges(content)).toStrictEqual([]);
});

test.each([
  ['annotation ranges protect closed placeholders with whitespace payloads', '{{VISUAL_SLOT:   }}'],
  ['annotation ranges parse parenthesized image titles', '![schema](image.png (Titolo nascosto))'],
  [
    'annotation ranges include definitions with a continued destination',
    '[ref]:\n  /image.png "Titolo nascosto"',
  ],
] as const)('%s', (_name, content) => {
  expect(getMarkdownAnnotationProtectedRanges(content)).toStrictEqual([
    { start: 0, end: content.length },
  ]);
});

test('annotation ranges parse balanced parentheses in image destinations', () => {
  const content =
    'Prima ![diagramma](https://example.com/image_(large).png) e ![schema](<schema.png> ) dopo.';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual([
    '![diagramma](https://example.com/image_(large).png)',
    '![schema](<schema.png> )',
  ]);
});

test('annotation ranges parse angle destinations with quoted and parenthesized titles', () => {
  const content = '[uno](<https://example.com> "Titolo") e ![due](<image.png> (Didascalia))';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual([
    '(<https://example.com> "Titolo")',
    '![due](<image.png> (Didascalia))',
  ]);
});

test('annotation ranges keep adjacent inline code separate from an image', () => {
  const content = '![diagramma](image.png)`codice inline`';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual(['![diagramma](image.png)', '`codice inline`']);
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

  expect(protectedSlices.includes('![Schema nascosto][schema]')).toBeTruthy();
  assert.ok(protectedSlices.includes('(https://example.com/percorso-nascosto)'));
});

test('annotation ranges preserve malformed definitions and angle destinations', () => {
  const content = [
    '[ref]: destinazione non valida',
    '[ref]: image(non-bilanciata',
    '![alt](<destinazione non valida>)',
    '![alt](<image.png>testo)',
  ].join('\n');

  expect(getMarkdownAnnotationProtectedRanges(content)).toStrictEqual([]);
});

test.each([
  ['empty label', '[]: image.png'],
  ['whitespace label', '[   ]: image.png'],
  ['raw HTML block', '<div>\n[ref]: image.png\n</div>'],
  ['unmatched closing HTML tag', '</div>\n[ref]: image.png'],
  ['custom raw HTML block', '<custom>\n[ref]: image.png'],
  ['quoted custom tag', '<custom title="a>b">\n[ref]: image.png'],
  ['malformed closing custom tag', '</custom bad>\n[ref]: image.png'],
  ['quoted raw HTML block', '> <div>\n> [ref]: image.png\n> </div>'],
] as const)('annotation ranges preserve empty reference labels and definitions inside raw html blocks: %s', (_caseName, content) => {
  expect(getMarkdownAnnotationProtectedRanges(content)).toStrictEqual([]);
});

test('html-looking fenced code does not hide a following reference definition', () => {
  const content = '```html\n<div>\n```\n![alt][ref]\n\n[ref]: /image.png';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices.includes('[ref]: /image.png')).toBeTruthy();
  assert.ok(protectedSlices.includes('![alt][ref]'));
});

test('annotation ranges resolve escaped reference labels', () => {
  const content = '![Alt nascosto][a\\]b]\n\n[a\\]b]: image.png';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices.includes('![Alt nascosto][a\\]b]')).toBeTruthy();
});

test('annotation ranges include complete multiline reference definitions', () => {
  const content = '[ref]: /image.png\n  "Titolo nascosto"';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual([content]);
});

test.each([
  ['zero-indent continuation', '![alt][ref]\n\n[ref]:\n/image.png "Titolo"'],
  ['blockquote container', '> [ref]: /image.png\n>\n> ![alt][ref]'],
  ['list container', '- [ref]: /image.png\n\n  ![alt][ref]'],
] as const)('annotation ranges include zero-indent and container-scoped reference definitions: %s', (_caseName, content) => {
  const protectedText = getMarkdownAnnotationProtectedRanges(content)
    .map(range => content.slice(range.start, range.end))
    .join('\n');
  expect(protectedText).toMatch(/\[ref\]:/u);
  assert.match(protectedText, /!\[alt\]\[ref\]/u);
});

test.each([
  ['plain continuation', '[ref]:\nnot a destination with spaces'],
  ['list continuation', '[ref]:\n- /visible-list-destination'],
  ['missing label', '[visibile][mancante]'],
] as const)('annotation ranges preserve malformed continuations and missing reference labels: %s', (_caseName, content) => {
  expect(getMarkdownAnnotationProtectedRanges(content)).toStrictEqual([]);
});

test('annotation ranges follow renderer-normalized tab-indented definitions', () => {
  const content = '\t[ref]: /image.png';

  expect(getMarkdownReferenceDefinitionRanges(content)).toStrictEqual([
    { start: 0, end: content.length },
  ]);
  assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), [
    { start: 0, end: content.length },
  ]);
});

test('annotation ranges protect footnote labels while preserving the visible definition body', () => {
  const content = 'Testo[^nota]\n\n[^nota]: /contenuto-visibile';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual(['[^nota]', '[^nota]: ']);
  assert.equal(
    getMarkdownAnnotationProtectedRanges(content).some(range =>
      content.slice(range.start, range.end).includes('/contenuto-visibile')
    ),
    false
  );
});

test('analysis hides renderer-hidden HTML inside escaped raw HTML', () => {
  const content = '<script>\n\n<!-- internal -->\n\n</script>';
  const hiddenSlices = parseMarkdownAnalysis(content).htmlSyntaxRanges.map(range =>
    content.slice(range.start, range.end)
  );

  expect(hiddenSlices).toStrictEqual(['<!-- internal -->']);
});

test('annotation ranges reuse every renderer-normalized math form', () => {
  const content = [
    String.raw`Parentesi (\text{velocity}) visibile.`,
    String.raw`x = \frac{a}{b}`,
    '[y_1 = z^2]',
  ].join('\n');
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices.includes(String.raw`(\text{velocity})`)).toBeTruthy();
  assert.ok(protectedSlices.includes(String.raw`x = \frac{a}{b}`));
  assert.ok(protectedSlices.includes('[y_1 = z^2]'));
});

test('annotation ranges leave prose lookalikes anchorable and bare math inside code alone', () => {
  const content = [
    '(nota testuale)',
    '[nota editoriale]',
    '```md',
    String.raw`(\text{code})`,
    '```',
  ].join('\n');
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(!protectedSlices.includes('(nota testuale)')).toBeTruthy();
  assert.ok(!protectedSlices.includes('[nota editoriale]'));
  assert.ok(!protectedSlices.includes(String.raw`(\text{code})`));
});

test('markdown ranges keep inline code distinct from math inside escaped raw html', () => {
  const content = '<div>`$x$`</div>';
  const protectedSlices = getMarkdownProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual(['`$x$`']);
});

test('markdown ranges protect fenced code exposed by escaped raw html', () => {
  const content = '<div>\n```\nsecret\n```\n</div>';
  const protectedSlices = getMarkdownProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual(['```\nsecret\n```']);
});

test('annotation ranges protect images and link destinations exposed by escaped raw html', () => {
  const content = '<div>\n![Schema](image.png) and [docs](https://example.com/hidden)\n</div>';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual(['![Schema](image.png)', '(https://example.com/hidden)']);
});

test('annotation ranges protect reference labels exposed by escaped raw html', () => {
  const content = '<div>\n[docs][ref]\n\n[ref]: https://example.com\n</div>';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual(['[ref]', '[ref]: https://example.com']);
});

test('annotation ranges protect footnote labels exposed by escaped raw html', () => {
  const content = '<div>\nTesto[^nota]\n</div>\n\n[^nota]: Corpo';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedSlices).toStrictEqual(['[^nota]', '[^nota]: ']);
});

test('code ranges exposed by escaped raw html stay in source order', () => {
  const content = '<div>\n`<mark>early</mark>`\n</div>\n\n`<mark>later</mark>`';

  expect(stripHighlightTagsInsideMarkdownCode(content)).toBe('<div>\n`early`\n</div>\n\n`later`');
});

test('annotation ranges protect URI and email autolinks', () => {
  expect(getMarkdownAnnotationProtectedRanges('<https://example.com>')).toStrictEqual([
    { start: 0, end: 21 },
  ]);
  assert.deepEqual(getMarkdownAnnotationProtectedRanges('<reader@example.com>'), [
    { start: 0, end: 20 },
  ]);
});

test('annotation ranges preserve definition-like text indented as quoted code', () => {
  const content = '>     [ref]: /visible-code';

  expect(getMarkdownReferenceDefinitionRanges(content)).toStrictEqual([]);
});

test('annotation ranges respect list-relative continuations and nested tilde fences', () => {
  const content = [
    '- [ref]:',
    '    /image.png',
    '',
    '  ![Immagine][ref]',
    '',
    '> ~~~md',
    '> [falso]: /visibile-nel-codice',
    '> ~~~',
    '',
    '> - [nested]:',
    '>     /nested.png',
    '>',
    '>   ![Nested][nested]',
    '',
    '- Voce',
    '',
    '    ~~~md',
    '    - literal list marker',
    '    [lista]: /visibile-nel-codice',
    '    ~~~',
  ].join('\n');
  const protectedText = getMarkdownAnnotationProtectedRanges(content)
    .map(range => content.slice(range.start, range.end))
    .join('\n');

  expect(protectedText).toMatch(/- \[ref\]:\n {4}\/image\.png/u);
  assert.match(protectedText, /> ~~~md\n> \[falso\]: \/visibile-nel-codice\n> ~~~/u);
  assert.match(protectedText, /> - \[nested\]:\n> {5}\/nested\.png/u);
  assert.match(
    protectedText,
    / {4}~~~md\n {4}- literal list marker\n {4}\[lista\]: \/visibile-nel-codice\n {4}~~~/u
  );
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

test('code ranges do not synthesize fences for bare code-like or malformed input', () => {
  const bareCode = 'cpp while (i < 5) { std::cout << i; }';
  const malformedFence = ['{ "userId": 42 }', '```', '', 'Testo visibile.'].join('\n');

  assert.deepEqual(parseMarkdownAnalysis(bareCode).codeRanges, []);
  assert.deepEqual(parseMarkdownAnalysis(malformedFence).codeRanges, []);
});

test('fenced-code planning follows Markdown indentation for closing fences', () => {
  const indentedPseudoCloser = ['```ts', 'const value = 1;', '    ```'].join('\n');
  const quotedPseudoCloser = ['```ts', 'const value = 1;', '> ```'].join('\n');
  const quotedClosedFence = ['> ```ts', '> const value = 1;', '> ```'].join('\n');
  const loneCarriageReturnClosedFence = ['```ts', 'const value = 1;', '```'].join('\r');
  const differentlyIndentedClosedFences = [
    ['   ```ts', 'value', '```'].join('\n'),
    ['>   ```ts', '> value', '> ```'].join('\n'),
  ];

  assert.deepEqual(planMarkdownFencedCode(indentedPseudoCloser), {
    closedRanges: [],
    unclosedRanges: [{ start: 0, end: indentedPseudoCloser.length }],
  });
  assert.deepEqual(parseMarkdownAnalysis(indentedPseudoCloser).codeRanges, []);
  assert.deepEqual(parseMarkdownAnalysis(indentedPseudoCloser).rendererNormalizedIndentRanges, []);
  assert.deepEqual(planMarkdownFencedCode(quotedPseudoCloser), {
    closedRanges: [],
    unclosedRanges: [{ start: 0, end: quotedPseudoCloser.length }],
  });
  assert.deepEqual(planMarkdownFencedCode(quotedClosedFence), {
    closedRanges: [{ start: 0, end: quotedClosedFence.length }],
    unclosedRanges: [],
  });
  assert.deepEqual(planMarkdownFencedCode(loneCarriageReturnClosedFence), {
    closedRanges: [{ start: 0, end: loneCarriageReturnClosedFence.length }],
    unclosedRanges: [],
  });
  differentlyIndentedClosedFences.forEach(content => {
    assert.deepEqual(planMarkdownFencedCode(content), {
      closedRanges: [{ start: 0, end: content.length }],
      unclosedRanges: [],
    });
  });

  const unclosedListItems = ['- ```ts', '  first', '- ```js', '  second'].join('\n');
  const listPlan = planMarkdownFencedCode(unclosedListItems);
  assert.equal(listPlan.unclosedRanges.length, 2);
  assert.ok(listPlan.unclosedRanges[0].end <= listPlan.unclosedRanges[1].start);
});

test('fenced-code planning keeps lone-CR sibling blocks and prose bounded', () => {
  const firstBlock = ['```a', 'one', '```'].join('\r');
  const secondBlock = ['```b', 'two', '```'].join('\r');
  const content = [firstBlock, 'visible prose', secondBlock].join('\r');

  assert.deepEqual(
    planMarkdownFencedCode(content).closedRanges.map(range =>
      content.slice(range.start, range.end)
    ),
    [firstBlock, secondBlock]
  );
  assert.deepEqual(
    parseMarkdownAnalysis(content).codeRanges.map(range => content.slice(range.start, range.end)),
    [firstBlock, secondBlock]
  );
});

test('analysis projects accidental indentation after lone-CR boundaries', () => {
  const content = 'Before\r\r    plain text\r\rAfter';
  const analysis = parseMarkdownAnalysis(content);

  assert.deepEqual(analysis.codeRanges, []);
  assert.deepEqual(
    analysis.rendererNormalizedIndentRanges.map(range => content.slice(range.start, range.end)),
    ['    ']
  );
});

test('analysis exposes Markdown syntax after an unclosed fence opener', () => {
  const content = ['~~~ts', '[Docs](https://example.com)'].join('\n');
  const destinationSlices = parseMarkdownAnalysis(content).linkDestinationRanges.map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(destinationSlices, ['(https://example.com)']);
});

test('projects a batch of lone-CR malformed fence openers in one pass', () => {
  const openerCount = 256;
  const content = Array.from({ length: openerCount }, (_, index) => `\`\`\`lang${index}`).join(
    '\r'
  );

  const projection = projectUnclosedMarkdownFenceOpeners(content);

  assert.equal(projection.escapedOpenerRanges.length, openerCount);
  assert.deepEqual(planMarkdownFencedCode(projection.content).unclosedRanges, []);
  assert.deepEqual(
    projection.escapedOpenerRanges.map(range => content.slice(range.start, range.end)),
    Array.from({ length: openerCount }, () => '```')
  );
});

test('analysis exposes Markdown syntax after escaped raw HTML reveals an unclosed fence', () => {
  const content = ['<div>', '```ts', 'code', '</div>', '## After [Docs](https://e.test)'].join(
    '\n'
  );
  const analysis = parseMarkdownAnalysis(content);

  assert.deepEqual(
    analysis.escapedFenceOpenerRanges.map(range => content.slice(range.start, range.end)),
    ['```']
  );
  assert.deepEqual(
    analysis.linkDestinationRanges.map(range => content.slice(range.start, range.end)),
    ['(https://e.test)']
  );
  assert.deepEqual(analysis.codeRanges, []);
});

test('analysis preserves a valid fence exposed by nested malformed openers', () => {
  const content = ['`````', 'outer', '~~~~', 'middle', '```', 'inner', '```'].join('\n');
  const codeSlices = parseMarkdownAnalysis(content).codeRanges.map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(codeSlices, [['```', 'inner', '```'].join('\n')]);
});

test('annotation ranges protect supported backslash math delimiters', () => {
  const content = String.raw`Prima \(x + y\) e poi \[z = 1\].`;
  const protectedText = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedText).toStrictEqual([String.raw`\(x + y\)`, String.raw`\[z = 1\]`]);
});

test('annotation ranges keep renderer indentation normalization outside fenced code', () => {
  const content = ['~~~md', '    ~~~', 'hidden code', '~~~', 'visible prose'].join('\n');
  const protectedText = getMarkdownAnnotationProtectedRanges(content)
    .map(range => content.slice(range.start, range.end))
    .join('\n');

  expect(protectedText).toMatch(/ {4}~~~\nhidden code/u);
  assert.doesNotMatch(protectedText, /visible prose/u);
});

test('annotation ranges protect non-text block syntax', () => {
  const content = [
    'Titolo Setext',
    '===',
    '',
    '---',
    '',
    '| Visible | Text |',
    '| --- | --- |',
    '| Cell | Value |',
  ].join('\n');
  const protectedText = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  expect(protectedText.includes('===')).toBeTruthy();
  assert.ok(protectedText.includes('---'));
  assert.ok(protectedText.includes('| --- | --- |'));
});
