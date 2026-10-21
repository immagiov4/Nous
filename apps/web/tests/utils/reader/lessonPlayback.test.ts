// @vitest-environment jsdom

import { deriveLegacyLessonContent } from '@shared/lessonContent';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { MARKDOWN_RENDERING_CONTROL_PATTERN } from '@shared/markdownControlCharacters';
import { expect, test } from 'vitest';
import { applySectionAnnotation } from '../../../utils/learning/sectionAnnotations.ts';
import { buildVisibleProjection } from '../../../utils/markdown/textProjection.ts';
import {
  playbackSentenceSelector,
  playbackTimeline,
} from '../../../utils/reader/lessonPlayback.ts';

test('maps a spoken sentence through markup and content-block offsets into a normal reader annotation', () => {
  const source = [
    { type: 'markdown' as const, markdown: '  ## Prima\n\nUna premessa.  ' },
    { type: 'markdown' as const, markdown: 'La **prima** frase. La seconda frase.' },
  ];
  const blocks = segmentLessonPlayback(source);
  const selector = playbackSentenceSelector(blocks[1], 0, 12, source);
  expect(selector?.exact).toBe('La prima frase.');
  const content = deriveLegacyLessonContent(source);
  const result = applySectionAnnotation({
    content,
    note: 'Ricordare questo.',
    selectedText: selector?.exact ?? '',
    selectedTextStart: selector?.selectionStart,
    contextBefore: selector?.prefix,
    contextAfter: selector?.suffix,
  });
  expect(result?.annotations).toHaveLength(1);
  const annotation = result?.annotations[0];
  expect(annotation?.anchor?.kind).toBe('selection');
  if (annotation?.anchor?.kind === 'selection')
    expect(
      content.slice(annotation.anchor.selector.start, annotation.anchor.selector.end)
    ).toContain('**prima**');
});

test('seeking selects the corresponding sentence and disambiguates repeated text', () => {
  const source = [
    {
      type: 'markdown' as const,
      markdown: 'Prima frase. Frase uguale.\n\nFrase uguale. Ultima frase.',
    },
  ];
  const blocks = segmentLessonPlayback(source);
  const first = playbackSentenceSelector(blocks[0], 8, 10, source);
  const second = playbackSentenceSelector(blocks[1], 0, 10, source);
  expect(first?.exact).toBe(second?.exact);
  expect(second?.start).toBeGreaterThan(first?.start ?? 0);
});

test('the timeline replaces estimated durations with measured recordings', () => {
  const blocks = segmentLessonPlayback([
    { type: 'markdown', markdown: 'Due parole.\n\nQui quattro parole scritte.' },
  ]);
  blocks[0] = {
    ...blocks[0],
    audio: [
      {
        model: 'tts',
        voice: 'Kore',
        durationSeconds: 4,
        asset: { id: 'a'.repeat(64), hash: 'a'.repeat(64), mediaType: 'audio/mpeg', byteSize: 1 },
      },
    ],
  };
  expect(playbackTimeline(blocks, 'Kore')).toEqual([
    { duration: 4, estimated: false },
    { duration: 8, estimated: true },
  ]);
});

test('maps a spoken mathematical phrase back to the complete source formula', () => {
  const source = [{ type: 'markdown' as const, markdown: 'Consideriamo $x^2$. Poi proseguiamo.' }];
  const raw = segmentLessonPlayback(source)[0];
  const block = {
    ...raw,
    prepared: { motion: [], spokenMath: [{ formula: '$x^2$', spoken: 'ics al quadrato' }] },
  };
  const selector = playbackSentenceSelector(block, 5, 8, source);
  expect(selector?.exact).toBe('Consideriamo x2.');
  expect(source[0].markdown.slice(selector?.start, selector?.end)).toContain('$x^2$');
});

test('anchors narrated fenced prose to its complete original source instead of pronunciation offsets', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: 'Introduction.\n\n```text\nA vector has two entries.\n```',
    },
  ];
  const raw = segmentLessonPlayback(sources)[0];
  const block = {
    ...raw,
    prepared: {
      motion: [],
      spokenMath: [],
      fencedCode: [{ visualIndex: 0, kind: 'prose' as const, spoken: 'A vector has two entries.' }],
    },
  };
  const selector = playbackSentenceSelector(block, 9, 10, sources);
  expect(selector?.exact).toBe('A vector has two entries.');
  expect(sources[0].markdown.slice(selector?.start, selector?.end)).toContain(
    'A vector has two entries.'
  );
});

test('keeps a formula after a pending heading with its spoken block', () => {
  const blocks = segmentLessonPlayback([
    { type: 'markdown', markdown: 'Intro.\n\n## Topic\n\n$$x = 2$$\n\nThen.' },
  ]);
  expect(blocks).toHaveLength(2);
  expect(blocks[0].visuals).toEqual([]);
  expect(blocks[1].spans.filter(span => span.math).map(span => span.math)).toEqual(['$$x = 2$$']);
  expect(blocks[1].visuals).toEqual([{ kind: 'markdown', markdown: '$$x = 2$$' }]);
});

test.each([
  'Se\u007flect this passage.',
  'Se\u001b[31mlect\u001b[0m this passage.',
])('projects rendering controls out of speech while preserving source offsets: %j', markdown => {
  const source = [{ type: 'markdown' as const, markdown }];
  const blocks = segmentLessonPlayback(source);
  expect(blocks.map(block => block.speech)).toEqual(['Select this passage.']);
  const selector = playbackSentenceSelector(blocks[0], 0, blocks[0].speech.length, source);
  expect(selector?.exact).toBe('Select this passage.');
  expect(selector?.selectionStart).toBe(0);
});

test.each([
  '\u007f',
  '\u001b[31m',
])('keeps heading structure across rendering controls: %j', control => {
  const markdown = `${control}# Heading\n\nBody.`;
  const blocks = segmentLessonPlayback([{ type: 'markdown', markdown }]);
  expect(blocks[0].heading).toBe('Heading');
  expect(blocks[0].speech).toBe('Heading\nBody.');
  expect(blocks[0].spans[0].source.start).toBe(control.length + 2);
});

test.each([
  '\u007f',
  '\u001b[31m',
])('ends an inline-code source range before a following rendering control: %j', control => {
  const markdown = `Use \`ab\`${control} here.`;
  const blocks = segmentLessonPlayback([{ type: 'markdown', markdown }]);
  expect(blocks.map(block => block.speech)).toEqual(['Use ab here.']);
});

test('keeps displayed text, speech and source offsets when controls occur at every Markdown boundary', () => {
  const source =
    '# Heading\n\nUse `ab` and **bold** with $a+b$.\n\n![alt](image.png)\n\n```js\nx()\n```\n\nAfter \\*literal\\* and {{PDF_IMAGE:asset}}.';
  const expected = segmentLessonPlayback([{ type: 'markdown', markdown: source }]).map(block => ({
    speech: block.speech,
    heading: block.heading,
  }));
  const expectedText = buildVisibleProjection(source).text;
  for (const control of ['\u007f', '\u001b[31m']) {
    for (let index = 0; index <= source.length; index += 1) {
      const markdown = source.slice(0, index) + control + source.slice(index);
      const blocks = segmentLessonPlayback([{ type: 'markdown', markdown }]);
      expect(blocks.map(block => ({ speech: block.speech, heading: block.heading }))).toEqual(
        expected
      );
      expect(buildVisibleProjection(markdown).text).toBe(expectedText);
      for (const block of blocks) {
        for (const span of block.spans) {
          if (span.math || span.fencedCode || span.source.start === span.source.end) continue;
          expect(
            markdown
              .slice(span.source.start, span.source.end)
              .replaceAll(MARKDOWN_RENDERING_CONTROL_PATTERN, '')
          ).toBe(block.speech.slice(span.speech.start, span.speech.end));
        }
      }
    }
  }
});
