import {
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
  projectLessonPlayback,
  segmentLessonPlayback,
} from '@shared/lessonPlayback';
import { describe, expect, test } from 'vitest';

const markdownBlock = (markdown: string): PlaybackContentBlock => ({ type: 'markdown', markdown });

const expectExactSpans = (
  block: LessonPlaybackBlock,
  source: string | readonly PlaybackContentBlock[]
): void => {
  let speechEnd = 0;
  for (const span of block.spans) {
    const content =
      typeof source === 'string' ? markdownBlock(source) : source[span.sourceBlockIndex];
    expect(content?.type).toBe('markdown');
    if (content?.type !== 'markdown') throw new Error('Expected a markdown source block.');
    const { markdown } = content;
    expect(span.speech.start).toBe(speechEnd);
    if (span.math) {
      expect(span.speech.end).toBe(span.speech.start);
      expect(markdown.slice(span.source.start, span.source.end)).toBe(span.math);
      continue;
    }
    expect(span.speech.end).toBeGreaterThan(span.speech.start);
    expect(span.source.start).toBeGreaterThanOrEqual(0);
    expect(span.source.end).toBeLessThanOrEqual(markdown.length);
    const speech = block.speech.slice(span.speech.start, span.speech.end);
    if (span.source.start === span.source.end) expect(speech).toBe('\n');
    else expect(markdown.slice(span.source.start, span.source.end)).toBe(speech);
    speechEnd = span.speech.end;
  }
  expect(speechEnd).toBe(block.speech.length);
};

describe('lesson playback segmentation', () => {
  test('preserves authored words, punctuation and UTF-16 offsets', () => {
    const markdown = 'È così: 10–12, «perché?» 🧠\nAncora qui!\n\nSecondo paragrafo.';
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual([
      'È così: 10–12, «perché?» 🧠\nAncora qui!',
      'Secondo paragrafo.',
    ]);
    expect(blocks.map(block => block.id)).toEqual(['0', '1']);
    for (const block of blocks) {
      expect(block.heading).toBe('');
      expect(block.spans.every(span => span.sourceBlockIndex === 0)).toBe(true);
      expect(block).not.toHaveProperty('sourceBlockIndex');
      expect(block.audio).toEqual([]);
      expect(block.visuals).toEqual([]);
      expect(block).not.toHaveProperty('prepared');
      expectExactSpans(block, markdown);
    }
  });

  test.each([
    '\n',
    '\r\n',
    '\r',
  ])('keeps prose around multiline visuals in one segment (%j)', newline => {
    for (const [open, close] of [
      ['$$', '$$'],
      ['\\[', '\\]'],
    ]) {
      const formula = [open, 'x + y', '', '= z', close].join(newline);
      const markdown = `The calculation continues${newline}${formula}${newline}with this result.${newline}${newline}A separate paragraph.`;
      const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
      expect(blocks.map(block => block.speech)).toEqual([
        `The calculation continues${newline}${newline}with this result.`,
        'A separate paragraph.',
      ]);
      expect(blocks[0].visuals).toHaveLength(1);
      const visual = blocks[0].visuals[0];
      expect(visual.kind).toBe('markdown');
      if (visual.kind !== 'markdown') throw new Error('Expected the authored formula visual.');
      expect(visual.markdown).toContain(formula);
      expect(blocks[1].visuals).toEqual([]);
      for (const block of blocks) expectExactSpans(block, markdown);
    }
  });

  test.each([
    '',
    '\n',
  ])('recognizes later headings after heading-like lines inside a formula (%j)', blank => {
    const formula = `$$\n${blank}x\n=\ny\n$$`;
    const markdown = `The calculation continues\n${formula}\nwith this result.\n\n# Next topic\nThe explanation.\n\n## Detail\nMore detail.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.heading)).toEqual(['', 'Next topic', 'Detail']);
    expect(blocks.map(block => block.speech)).toEqual([
      'The calculation continues\n\nwith this result.',
      'Next topic\nThe explanation.',
      'Detail\nMore detail.',
    ]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    '# x $$',
    '# x $$ trailing',
  ])('keeps real headings after visual-internal heading lines: %s', ending => {
    const markdown = `Intro\n$$\n${ending}\nresult.\n\n# Topic\nBody.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.heading)).toEqual(['', 'Topic']);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    { kind: 'thematic break', markdown: '---' },
    { kind: 'code', markdown: '```text\ninner code\n```' },
    { kind: 'table', markdown: '| A | B |\n| --- | --- |\n| x | y |' },
    { kind: 'definition', markdown: '[inside]: https://example.test/inside' },
  ])('preserves later parser blocks after a $kind in multiline math', ({ markdown: internal }) => {
    const formula = `$$\nx\n\n${internal}\n\ny\n$$`;
    const code = '```ts\nconst result = 1;\n```';
    const table = '| Input | Output |\n| --- | --- |\n| 1 | 2 |';
    const markdown = `Introduction.\n${formula}\nResult.\n\n${code}\n\n${table}\n\n[ref]: https://example.test\n\n***\n\nRead [the reference][ref].`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual([
      'Introduction.\n\nResult.',
      'Read the reference.',
    ]);
    expect(blocks[0].visuals).toEqual([
      { kind: 'markdown', markdown: `Introduction.\n${formula}\nResult.` },
      { kind: 'markdown', markdown: code },
      { kind: 'markdown', markdown: table },
    ]);
    expect(blocks[1].visuals).toEqual([]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test('keeps a math delimiter inside an external code block protected', () => {
    const code = '```tex\n$$\n```';
    const markdown = `Unclosed $$\n\n${code}\n\nAfter.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Unclosed $$', 'After.']);
    expect(blocks[0].visuals).toEqual([{ kind: 'markdown', markdown: code }]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test('speaks headings once and keeps the latest heading on following blocks', () => {
    const markdown =
      'Prima.\n\n# Tema\n\n## Dettaglio\nUn fatto.\n\nUn altro.\n\n###### Fine\n\nConclusione.';
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.heading)).toEqual(['', 'Dettaglio', 'Dettaglio', 'Fine']);
    expect(blocks.map(block => block.speech)).toEqual([
      'Prima.',
      'Tema\nDettaglio\nUn fatto.',
      'Un altro.',
      'Fine\nConclusione.',
    ]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    { heading: 'Titolo', source: 'Titolo\n===' },
    { heading: 'Titolo', source: 'Titolo\r\n---' },
    { heading: 'Prima riga\nseconda riga', source: 'Prima riga\nseconda riga\n===' },
    { heading: 'Titolo', source: '## Titolo ##' },
    { heading: 'Topic ', source: '# Topic $x$' },
    { heading: 'Topic ', source: 'Topic $x$\n===' },
  ])('reads parsed heading text without its markers: $source', ({ heading, source }) => {
    const markdown = `${source}\n\nProsa.\n\nAncora.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.heading)).toEqual([heading, heading]);
    expect(blocks.map(block => block.speech)).toEqual([`${heading}\nProsa.`, 'Ancora.']);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    String.raw`$\frac{a}{b}$`,
    String.raw`\(x + y\)`,
    '$$\nE = mc^2\n$$',
    String.raw`\[E = mc^2\]`,
  ])('retains delimited math and pending inline pronunciations with exact source spans: %s', formula => {
    const markdown = `Prima ${formula} dopo.\n\n ${formula} \n\nPoi.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Prima  dopo.', 'Poi.']);
    expect(blocks[0]?.visuals).toEqual([
      { kind: 'markdown', markdown: `Prima ${formula} dopo.` },
      { kind: 'markdown', markdown: formula },
    ]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test('retains literal math in code and escaped dollar text', () => {
    const markdown = 'Prima `$x$` e `\\(x\\)`, poi \\$ prezzo.\n\n```tex\n$x$\n```';
    const [block] = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(block?.speech).toBe(String.raw`Prima $x$ e \(x\), poi $ prezzo.`);
    expect(block?.visuals).toEqual([{ kind: 'markdown', markdown: '```tex\n$x$\n```' }]);
    expectExactSpans(block as LessonPlaybackBlock, markdown);
  });

  test('preserves authored order when math, images and PDF placeholders share a block', () => {
    const image = '![Figura](image.png)';
    const pdf = '{{PDF_IMAGE:asset|alt=Immagine}}';
    const markdown = `Prima $x$ poi ${image} infine $y$ e ${pdf}.`;
    const [block] = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(block?.speech).toBe('Prima  poi  infine  e .');
    expect(block?.visuals).toEqual([{ kind: 'markdown', markdown }]);
    expectExactSpans(block as LessonPlaybackBlock, markdown);
  });

  test('keeps each list and blockquote chunk together', () => {
    const markdown =
      '- Uno.\n* Due!\n+ Tre?\n\n1. Primo;\n2) secondo.\n\n> Una voce:\n> > «Ascolta».\n\nProsa.';
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual([
      'Uno.\nDue!\nTre?',
      'Primo;\nsecondo.',
      'Una voce:\n«Ascolta».',
      'Prosa.',
    ]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    '\n',
    '\r\n',
    '\r',
  ])('splits adjacent paragraph, list and quote boundaries (%j)', newline => {
    const markdown = ['Introduzione.', '- Primo.', '- Secondo.', '> Citazione.', '> Ancora.'].join(
      newline
    );
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual([
      'Introduzione.',
      `Primo.${newline}Secondo.`,
      `Citazione.${newline}Ancora.`,
    ]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    '> >\t- ',
    '>\t> 12) ',
    '>>+\t',
  ])('strips nested quote and list prefixes while preserving speech offsets: %j', prefix => {
    const markdown = `${prefix}Prima 🧠.\r\n${prefix}**Poi.**`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Prima 🧠.\r\nPoi.']);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    '- Introduzione.\n\n  ```ts\n  const value = 1;\n  ```\n\nDopo.',
    '> Introduzione.\n>\n> ```ts\n> const value = 1;\n> ```\n\nDopo.',
    'Introduzione.\n\n    const value = 1;\n\nDopo.',
  ])('excludes container-relative and indented code from speech', markdown => {
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech.trim())).toEqual(['Introduzione.', 'Dopo.']);
    expect(blocks[0]?.visuals).toEqual([
      { kind: 'markdown', markdown: expect.stringContaining('const value = 1;') },
    ]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test('recognizes GFM tables with optional pipes and retains ordinary mathematical text', () => {
    const table = 'Label|Value\n---|---\nUno|Due';
    const markdown = `Introduzione.\n${table}\n\n|x| = 3`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Introduzione.', '|x| = 3']);
    expect(blocks[0]?.visuals).toEqual([{ kind: 'markdown', markdown: table }]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    '[ref]: https://example.test',
    '[ref]:\n  https://example.test\n  "Titolo $x$"',
    '> [ref]: https://example.test\n>   "Titolo"',
    '- [ref]: https://example.test',
  ])('omits reference definitions while retaining linked prose: %s', definition => {
    const markdown = `${definition}\n\nUna [fonte][ref], [ref][] e [ref].\n\nDopo.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Una fonte, ref e ref.', 'Dopo.']);
    expect(blocks.map(block => block.id)).toEqual(['0', '1']);
    for (const block of blocks) {
      expect(block.visuals).toEqual([]);
      expectExactSpans(block, markdown);
    }
    expect(segmentLessonPlayback([markdownBlock(definition)])).toEqual([]);
  });

  test('separates a definition from immediately following prose', () => {
    const markdown = '[ref]: https://example.test\n  "Titolo"\nLeggi [fonte][ref].';
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Leggi fonte.']);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    '---',
    '***',
    '___',
    '* * *',
    '> ---',
    '- ***',
  ])('omits parsed thematic breaks without producing speech or visuals: %s', separator => {
    const markdown = `Prima.\r\n\r\n${separator}\r\nDopo.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Prima.', 'Dopo.']);
    expect(blocks.map(block => block.id)).toEqual(['0', '1']);
    for (const block of blocks) {
      expect(block.visuals).toEqual([]);
      expectExactSpans(block, markdown);
    }
    expect(segmentLessonPlayback([markdownBlock(separator)])).toEqual([]);
  });

  test('preserves definition and separator syntax when authored as code', () => {
    const code = '```md\n[ref]: https://example.test\n\n---\n```';
    const markdown = `Scrivi \`[ref]: https://example.test\` e \`---\`.\n\n${code}`;
    const [block] = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(block?.speech).toBe('Scrivi [ref]: https://example.test e ---.');
    expect(block?.visuals).toEqual([{ kind: 'markdown', markdown: code }]);
    expectExactSpans(block as LessonPlaybackBlock, markdown);
  });

  test('keeps inline images and canonical PDF image placeholders visual-only', () => {
    const image = '![Diagramma](d.png)';
    const pdf = '{{PDF_IMAGE:asset-1|alt=Figura|caption=Esempio}}';
    const markdown = `Guarda ${image} qui.\n\n${pdf}\n\nPoi ${pdf} prosegui.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Guarda  qui.', 'Poi  prosegui.']);
    expect(blocks[0]?.visuals).toEqual([
      { kind: 'markdown', markdown: image },
      { kind: 'markdown', markdown: pdf },
    ]);
    expect(blocks[1]?.visuals).toEqual([{ kind: 'markdown', markdown: pdf }]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test('retains images inside emphasis while code keeps image syntax literal', () => {
    const image = '![Foto](a.png)';
    const pdf = '{{PDF_IMAGE:1|alt=Foto}}';
    const markdown = `Prima **${image}** e *${pdf}* dopo.\n\n\`${image}\` resta testo.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Prima  e  dopo.', `${image} resta testo.`]);
    expect(blocks[0]?.visuals).toEqual([
      { kind: 'markdown', markdown: image },
      { kind: 'markdown', markdown: pdf },
    ]);
    expect(blocks[1]?.visuals).toEqual([]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test('protects literal image syntax in multiline inline code', () => {
    const markdown = 'Prima `a\n![Foto](a.png)` dopo.';
    const [block] = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(block?.speech).toBe('Prima a\n![Foto](a.png) dopo.');
    expect(block?.visuals).toEqual([]);
    expectExactSpans(block as LessonPlaybackBlock, markdown);
  });

  test('preserves escaped backticks, including runs before genuine inline code', () => {
    const markdown = 'Un \\`segno\\` e \\`\\`due\\`\\`, poi `a_b * c`.';
    const [block] = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(block?.speech).toBe('Un `segno` e ``due``, poi a_b * c.');
    expectExactSpans(block as LessonPlaybackBlock, markdown);
  });

  test('skips quizzes and YouTube clips while retaining original content block indexes', () => {
    const content: readonly PlaybackContentBlock[] = [
      { type: 'inline-quiz' },
      markdownBlock('Prima.'),
      { type: 'youtube-clips' },
      { type: 'inline-quiz' },
      markdownBlock('Poi.'),
    ];
    const snapshot = structuredClone(content);
    const blocks = segmentLessonPlayback(content);
    expect(blocks.map(block => [block.id, block.spans[0]?.sourceBlockIndex, block.speech])).toEqual(
      [
        ['0', 1, 'Prima.'],
        ['1', 4, 'Poi.'],
      ]
    );
    expect(segmentLessonPlayback(content)).toEqual(blocks);
    expect(content).toEqual(snapshot);
    for (const block of blocks) expectExactSpans(block, content);
  });

  test.each(['\n', '\r\n'])('preserves fenced code with blank lines verbatim (%j)', newline => {
    const code = ['```ts', 'const value = 1;', '', '# literal heading', '', '```'].join(newline);
    const markdown = `Introduzione.${newline}${code}${newline}Dopo.`;
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['Introduzione.', 'Dopo.']);
    expect(blocks[0]?.visuals).toEqual([{ kind: 'markdown', markdown: code }]);
    expect(blocks[1]?.visuals).toEqual([]);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test('keeps shorter fences inside a longer fence and accepts tilde fences', () => {
    const code = '````md\n```\n\ninside\n```\n````';
    const tilde = '~~~text\nmore\n\ncode\n~~~';
    const blocks = segmentLessonPlayback([markdownBlock(`Prima.\n${code}\n${tilde}`)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.visuals).toEqual([
      { kind: 'markdown', markdown: code },
      { kind: 'markdown', markdown: tilde },
    ]);
  });

  test('attaches tables and standalone images in source order', () => {
    const table = '| Uno | Due |\n| --- | --- |\n| 1 | 2 |';
    const image = '![Un esempio](https://example.test/image.png "Titolo")';
    const blocks = segmentLessonPlayback([
      markdownBlock(`Guarda.\n\n${table}\n\n${image}\n\nPoi.`),
    ]);
    expect(blocks.map(block => block.speech)).toEqual(['Guarda.', 'Poi.']);
    expect(blocks[0]?.visuals).toEqual([
      { kind: 'markdown', markdown: table },
      { kind: 'markdown', markdown: image },
    ]);
  });

  test('attaches produced generated visuals and leaves missing ones for later preparation', () => {
    const blocks = segmentLessonPlayback([
      markdownBlock('Prima.'),
      { type: 'generated-visual', visualId: 'visual-1' },
      { type: 'generated-visual' },
      { type: 'generated-visual', visualId: 'visual-2' },
      markdownBlock('Poi.'),
      { type: 'generated-visual' },
    ]);
    expect(blocks[0]?.visuals).toEqual([
      { kind: 'generated-visual', visualId: 'visual-1' },
      { kind: 'generated-visual', visualId: 'visual-2' },
    ]);
    expect(blocks[1]?.visuals).toEqual([]);
  });

  test('attaches leading visuals to the next spoken block, across skipped content', () => {
    const image = '![Esempio](example.png)';
    const code = '```text\nPrima\n\nDopo\n```';
    const blocks = segmentLessonPlayback([
      markdownBlock(image),
      { type: 'generated-visual', visualId: 'first' },
      { type: 'inline-quiz' },
      { type: 'youtube-clips' },
      markdownBlock(`${code}\n\nVoce.`),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.spans[0]?.sourceBlockIndex).toBe(4);
    expect(blocks[0]?.visuals).toEqual([
      { kind: 'markdown', markdown: image },
      { kind: 'generated-visual', visualId: 'first' },
      { kind: 'markdown', markdown: code },
    ]);
  });

  test('removes inline markup and maps every speech character to exact source text', () => {
    const markdown =
      '**Forte**, *piano*, _bene_, __ancora__: `a_b * c` e [una fonte](https://example.test/a(b)).';
    const [block] = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(block?.speech).toBe('Forte, piano, bene, ancora: a_b * c e una fonte.');
    expect(block).toBeDefined();
    expectExactSpans(block as LessonPlaybackBlock, markdown);
  });

  test('preserves literal underscores, multiplication and unmatched emphasis markers', () => {
    const markdown = 'snake_case_name, x_y_z, 2 * 3 * 4; _aperto e finale*.';
    const [block] = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(block?.speech).toBe(markdown);
    expectExactSpans(block as LessonPlaybackBlock, markdown);
  });

  test('strips nested emphasis inside links while preserving code punctuation', () => {
    const markdown = '[**Una** fonte](https://example.test), ***bene*** e ``a ` b``.';
    const [block] = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(block?.speech).toBe('Una fonte, bene e a ` b.');
    expectExactSpans(block as LessonPlaybackBlock, markdown);
  });

  test('preserves CRLF and UTF-16 positions inside multiline speech', () => {
    const markdown = '\r\n# 🧠 Tema\r\n\r\n- Uno.\r\n- **Due!**\r\n\r\nFine.';
    const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
    expect(blocks.map(block => block.speech)).toEqual(['🧠 Tema\r\nUno.\r\nDue!', 'Fine.']);
    for (const block of blocks) expectExactSpans(block, markdown);
  });

  test.each([
    '',
    '\n',
    '\r\n',
  ])('maps headings and paragraphs from different markdown blocks (%j)', newline => {
    const content: readonly PlaybackContentBlock[] = [
      markdownBlock(`# **🧠 Tema**${newline}`),
      { type: 'inline-quiz' },
      { type: 'generated-visual', visualId: 'intro' },
      markdownBlock('Una [fonte](https://example.test).\n\nAncora.'),
    ];
    const blocks = segmentLessonPlayback(content);
    expect(blocks.map(block => block.speech)).toEqual([
      `🧠 Tema${newline || '\n'}Una fonte.`,
      'Ancora.',
    ]);
    expect(blocks.map(block => block.heading)).toEqual(['🧠 Tema', '🧠 Tema']);
    expect(blocks[0]?.visuals).toEqual([{ kind: 'generated-visual', visualId: 'intro' }]);
    expect(new Set(blocks[0]?.spans.map(span => span.sourceBlockIndex))).toEqual(new Set([0, 3]));
    expect(blocks[1]?.spans.every(span => span.sourceBlockIndex === 3)).toBe(true);
    for (const block of blocks) expectExactSpans(block, content);
  });

  test('does not emit headings on their own', () => {
    expect(segmentLessonPlayback([markdownBlock('# Tema')])).toEqual([]);
    expect(
      segmentLessonPlayback([markdownBlock('Prima.\n\n## Fine')]).map(block => block.speech)
    ).toEqual(['Prima.']);
  });

  test('returns no spoken blocks for empty or entirely visual content', () => {
    expect(segmentLessonPlayback([])).toEqual([]);
    expect(
      segmentLessonPlayback([
        markdownBlock(' \n\n'),
        markdownBlock('![Immagine](image.png)'),
        { type: 'generated-visual', visualId: 'only-visual' },
        { type: 'inline-quiz' },
        { type: 'youtube-clips' },
      ])
    ).toEqual([]);
  });
});

test.each([
  'Intro <mark data-nous-annotation-id="note">boundaries</mark> and <mark>interactions</mark>.',
  '<mark data-nous-annotation-id="note">Intro boundaries</mark> and interactions.',
  'Intro <MARK title="a > b">boundaries</MARK> and interactions.',
])('projects annotation markup out of speech with exact source spans: %s', markdown => {
  const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].speech).toBe('Intro boundaries and interactions.');
  expectExactSpans(blocks[0], markdown);
});

test('keeps literal annotation syntax in code, escaped text and unsupported HTML', () => {
  const markdown =
    'Use `<mark>literal</mark>` and \\<mark>escaped</mark> and <marker>text</marker>.';
  const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
  expect(blocks[0].speech).toBe(
    'Use <mark>literal</mark> and <mark>escaped and <marker>text</marker>.'
  );
  expectExactSpans(blocks[0], markdown);
});

test('projects multiline annotation HTML nodes while preserving authored source spans', () => {
  const markdown = '<mark data-nous-annotation-id="note">\nPassage visible.\n</mark>';
  const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
  expect(blocks.map(block => block.speech)).toEqual(['\nPassage visible.\n']);
  expectExactSpans(blocks[0], markdown);
});

test('keeps annotation-looking syntax inside HTML comments and other tag attributes literal', () => {
  const markdown = '<!-- <mark>literal</mark> -->\n\n<div title="<mark>">visible</div>';
  const blocks = segmentLessonPlayback([markdownBlock(markdown)]);
  expect(blocks.map(block => block.speech)).toEqual([
    '<!-- <mark>literal</mark> -->',
    '<div title="<mark>">visible</div>',
  ]);
  for (const block of blocks) expectExactSpans(block, markdown);
});

test.each([
  '<![CDATA[<mark>literal</mark>]]>',
  '<?instruction <mark>literal</mark> ?>',
])('preserves non-tag HTML nodes as unannotated content: %s', markdown => {
  const content = [markdownBlock(markdown)];
  const projection = projectLessonPlayback(content);
  expect(projection.hasAnnotations).toBe(false);
  expect(projection.contentBlocks).toEqual(content);
  expect(projection.blocks.map(block => block.speech)).toEqual([markdown]);
  expectExactSpans(projection.blocks[0], markdown);
});

test('keeps an inline mathematical reading and its definitions in one contextual visual', () => {
  const passage = String.raw`<mark data-nous-annotation-id="a">Read “the chance of </mark>$y$<mark data-nous-annotation-id="b"> given </mark>$x$<mark data-nous-annotation-id="c">”. The bar </mark>$\mid$<mark data-nous-annotation-id="d"> means given.</mark>`;
  const [block] = segmentLessonPlayback([markdownBlock(passage)]);
  expect(block.speech).toBe('Read “the chance of  given ”. The bar  means given.');
  expect(block.visuals).toEqual([
    {
      kind: 'markdown',
      markdown: String.raw`Read “the chance of $y$ given $x$”. The bar $\mid$ means given.`,
    },
  ]);
  expectExactSpans(block, passage);
});

test('keeps the explanation of mathematical symbols in spoken headings', () => {
  const markdown = '# The bar $\\mid$ means given\n\nContinue with the reading.';
  const [block] = segmentLessonPlayback([markdownBlock(markdown)]);
  expect(block.visuals).toEqual([
    { kind: 'markdown', markdown: String.raw`# The bar $\mid$ means given` },
  ]);
  expectExactSpans(block, markdown);
});
