import {
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
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
