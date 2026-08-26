import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  findInlineLinkDestinationEnd,
  getMarkdownAnnotationProtectedRanges,
  getMarkdownProtectedRanges,
  getMarkdownReferenceDefinitionRanges,
  normalizeMathSelectionArtifacts,
  parseMarkdownAnalysis,
  stripHighlightTagsInsideMarkdownCode,
} from '../../../utils/markdown/codeRanges.ts';

test('synthetic link parsing rejects a later valid destination', () => {
  const content = '(destinazione non valida) poi [valido](https://example.com)';

  assert.equal(findInlineLinkDestinationEnd(content, 0), -1);
});

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

test('annotation ranges leave incomplete placeholder-like text anchorable', () => {
  const content = 'Testo prima {{VISUAL_SLOT:bozza testo dopo';

  assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), []);
});

test('annotation ranges protect closed placeholders with whitespace payloads', () => {
  const content = '{{VISUAL_SLOT:   }}';

  assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), [
    { start: 0, end: content.length },
  ]);
});

test('annotation ranges preserve a malformed marker before a complete marker', () => {
  const content = 'Prima {{VISUAL_SLOT:bozza poi {{VISUAL_SLOT:slot-1}} dopo';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['{{VISUAL_SLOT:slot-1}}']);
});

test('annotation ranges leave placeholders with unknown options anchorable', () => {
  const content = '{{PDF_IMAGE:asset-1|foo=bar}}';

  assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), []);
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

test('annotation ranges parse parenthesized image titles', () => {
  const content = '![schema](image.png (Titolo nascosto))';

  assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), [
    { start: 0, end: content.length },
  ]);
});

test('annotation ranges parse parenthesized ordinary-link titles', () => {
  const content = '[schema](image.png (Titolo nascosto))';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['(image.png (Titolo nascosto))']);
});

test('annotation ranges parse angle destinations with quoted and parenthesized titles', () => {
  const content = '[uno](<https://example.com> "Titolo") e ![due](<image.png> (Didascalia))';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, [
    '(<https://example.com> "Titolo")',
    '![due](<image.png> (Didascalia))',
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

test('annotation ranges preserve empty reference labels and definitions inside raw html blocks', () => {
  const contents = [
    '[]: image.png',
    '[   ]: image.png',
    '<div>\n[ref]: image.png\n</div>',
    '</div>\n[ref]: image.png',
    '<custom>\n[ref]: image.png',
    '<custom title="a>b">\n[ref]: image.png',
    '</custom bad>\n[ref]: image.png',
    '> <div>\n> [ref]: image.png\n> </div>',
  ];

  contents.forEach(content => {
    assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), []);
  });
});

test('html-looking fenced code does not hide a following reference definition', () => {
  const content = '```html\n<div>\n```\n![alt][ref]\n\n[ref]: /image.png';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.ok(protectedSlices.includes('[ref]: /image.png'));
  assert.ok(protectedSlices.includes('![alt][ref]'));
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

test('annotation ranges include definitions with a continued destination', () => {
  const content = '[ref]:\n  /image.png "Titolo nascosto"';

  assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), [
    { start: 0, end: content.length },
  ]);
});

test('annotation ranges include zero-indent and container-scoped reference definitions', () => {
  const contents = [
    '![alt][ref]\n\n[ref]:\n/image.png "Titolo"',
    '> [ref]: /image.png\n>\n> ![alt][ref]',
    '- [ref]: /image.png\n\n  ![alt][ref]',
  ];

  contents.forEach(content => {
    const protectedText = getMarkdownAnnotationProtectedRanges(content)
      .map(range => content.slice(range.start, range.end))
      .join('\n');
    assert.match(protectedText, /\[ref\]:/u);
    assert.match(protectedText, /!\[alt\]\[ref\]/u);
  });
});

test('annotation ranges preserve malformed continuations and missing reference labels', () => {
  const contents = [
    '[ref]:\nnot a destination with spaces',
    '[ref]:\n- /visible-list-destination',
    '[visibile][mancante]',
  ];

  contents.forEach(content => {
    assert.deepEqual(getMarkdownAnnotationProtectedRanges(content), []);
  });
});

test('annotation ranges follow renderer-normalized tab-indented definitions', () => {
  const content = '\t[ref]: /image.png';

  assert.deepEqual(getMarkdownReferenceDefinitionRanges(content), [
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

  assert.deepEqual(protectedSlices, ['[^nota]', '[^nota]: ']);
  assert.equal(
    getMarkdownAnnotationProtectedRanges(content).some(range =>
      content.slice(range.start, range.end).includes('/contenuto-visibile')
    ),
    false
  );
});

test('annotation ranges protect dollar math exposed by escaped raw html', () => {
  const content = '<div>\n$x$\n</div>';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['$x$']);
});

test('analysis hides renderer-hidden HTML inside escaped raw HTML', () => {
  const content = '<script>\n\n<!-- internal -->\n\n</script>';
  const hiddenSlices = parseMarkdownAnalysis(content).htmlSyntaxRanges.map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(hiddenSlices, ['<!-- internal -->']);
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

  assert.ok(protectedSlices.includes(String.raw`(\text{velocity})`));
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

  assert.ok(!protectedSlices.includes('(nota testuale)'));
  assert.ok(!protectedSlices.includes('[nota editoriale]'));
  assert.ok(!protectedSlices.includes(String.raw`(\text{code})`));
});

test('markdown ranges keep inline code distinct from math inside escaped raw html', () => {
  const content = '<div>`$x$`</div>';
  const protectedSlices = getMarkdownProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['`$x$`']);
});

test('markdown ranges protect fenced code exposed by escaped raw html', () => {
  const content = '<div>\n```\nsecret\n```\n</div>';
  const protectedSlices = getMarkdownProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['```\nsecret\n```']);
});

test('annotation ranges protect images and link destinations exposed by escaped raw html', () => {
  const content = '<div>\n![Schema](image.png) and [docs](https://example.com/hidden)\n</div>';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['![Schema](image.png)', '(https://example.com/hidden)']);
});

test('annotation ranges protect reference labels exposed by escaped raw html', () => {
  const content = '<div>\n[docs][ref]\n\n[ref]: https://example.com\n</div>';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['[ref]', '[ref]: https://example.com']);
});

test('annotation ranges protect footnote labels exposed by escaped raw html', () => {
  const content = '<div>\nTesto[^nota]\n</div>\n\n[^nota]: Corpo';
  const protectedSlices = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedSlices, ['[^nota]', '[^nota]: ']);
});

test('code ranges exposed by escaped raw html stay in source order', () => {
  const content = '<div>\n`<mark>early</mark>`\n</div>\n\n`<mark>later</mark>`';

  assert.equal(stripHighlightTagsInsideMarkdownCode(content), '<div>\n`early`\n</div>\n\n`later`');
});

test('annotation ranges protect URI and email autolinks', () => {
  assert.deepEqual(getMarkdownAnnotationProtectedRanges('<https://example.com>'), [
    { start: 0, end: 21 },
  ]);
  assert.deepEqual(getMarkdownAnnotationProtectedRanges('<reader@example.com>'), [
    { start: 0, end: 20 },
  ]);
});

test('annotation ranges preserve definition-like text indented as quoted code', () => {
  const content = '>     [ref]: /visible-code';

  assert.deepEqual(getMarkdownReferenceDefinitionRanges(content), []);
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

  assert.match(protectedText, /- \[ref\]:\n {4}\/image\.png/u);
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

test('annotation ranges protect supported backslash math delimiters', () => {
  const content = String.raw`Prima \(x + y\) e poi \[z = 1\].`;
  const protectedText = getMarkdownAnnotationProtectedRanges(content).map(range =>
    content.slice(range.start, range.end)
  );

  assert.deepEqual(protectedText, [String.raw`\(x + y\)`, String.raw`\[z = 1\]`]);
});

test('annotation ranges keep renderer indentation normalization outside fenced code', () => {
  const content = ['~~~md', '    ~~~', 'hidden code', '~~~', 'visible prose'].join('\n');
  const protectedText = getMarkdownAnnotationProtectedRanges(content)
    .map(range => content.slice(range.start, range.end))
    .join('\n');

  assert.match(protectedText, / {4}~~~\nhidden code/u);
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

  assert.ok(protectedText.includes('==='));
  assert.ok(protectedText.includes('---'));
  assert.ok(protectedText.includes('| --- | --- |'));
});
