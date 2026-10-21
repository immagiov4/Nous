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

test('seek annotations use the saved acoustic word clock rather than equal word durations', () => {
  const source = [{ type: 'markdown' as const, markdown: 'Prima frase. Seconda frase.' }];
  const block = segmentLessonPlayback(source)[0];
  const alignment = { status: 'aligned' as const, onsets: [0.1, 0.4, 8, 8.4] };
  expect(playbackSentenceSelector(block, 7, 10, source, alignment)?.exact).toBe('Prima frase.');
  expect(playbackSentenceSelector(block, 8.1, 10, source, alignment)?.exact).toBe('Seconda frase.');
  expect(playbackSentenceSelector(block, 0.2, 10, source, alignment)?.exact).toBe('Prima frase.');
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

import { getPlaybackFormulaSources, playbackNonProseVisuals } from '@shared/lessonPlayback';

test('projects all equations together and retains their source group for the following explanation', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '# Formula\n\nLe due espressioni sono queste.\n\n$$x_i+y$$\n\n$$z=x^i$$\n\nIl pedice distingue le componenti.\n\n# Altra sezione\n\nUn altro tema.',
    },
  ];
  const blocks = segmentLessonPlayback(sources);
  const formula = blocks.find(block => block.spans.some(span => span.math));
  const explanation = blocks.find(block => block.speech.includes('Il pedice'));
  const other = blocks.find(block => block.speech.includes('Un altro tema'));
  if (!formula || !explanation || !other) throw new Error('All passages must be projected');
  const expected = ['$$x_i+y$$', '$$z=x^i$$'];
  expect(getPlaybackFormulaSources(formula, sources)).toEqual(expected);
  expect(getPlaybackFormulaSources(explanation, sources)).toEqual(expected);
  expect(getPlaybackFormulaSources(other, sources)).toEqual([]);
});

test('retains code tables and images while excluding narrated contextual prose', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        'Spiegazione $x_i$.\n\n| Nome | Valore |\n| --- | --- |\n| x | 1 |\n\n```lua\nreturn 1\n```\n\n![Esempio](https://example.test/image.png)',
    },
  ];
  const blocks = segmentLessonPlayback(sources);
  const visuals = blocks.flatMap(playbackNonProseVisuals);
  expect(
    visuals.map(visual => (visual.kind === 'markdown' ? visual.markdown : visual.kind)).join('\n')
  ).toContain('| Nome | Valore |');
  expect(
    visuals.map(visual => (visual.kind === 'markdown' ? visual.markdown : '')).join('\n')
  ).toContain('return 1');
  expect(
    visuals.map(visual => (visual.kind === 'markdown' ? visual.markdown : '')).join('\n')
  ).toContain('![Esempio]');
  expect(
    visuals.map(visual => (visual.kind === 'markdown' ? visual.markdown : '')).join('\n')
  ).not.toContain('Spiegazione');
});

test('keeps the complete equation when the following explanation contains an inline subscript', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '# Formula\n\nLa formula è\n\n$$h_i=b_i+w_i x$$\n\nIl pedice $i$ distingue le componenti.',
    },
  ];
  const block = segmentLessonPlayback(sources).find(block => block.speech.includes('Il pedice'));
  if (!block) throw new Error('Explanation must be projected');
  expect(getPlaybackFormulaSources(block, sources)).toEqual(['$$h_i=b_i+w_i x$$', '$i$']);
});

test('retains mathematical context across source blocks and stops at a heading', () => {
  const sources = [
    { type: 'markdown' as const, markdown: '# Formula\n\nLa formula è\n\n$$x_i+y$$' },
    { type: 'markdown' as const, markdown: 'Il pedice distingue le componenti.' },
    { type: 'markdown' as const, markdown: '# Altro tema\n\nUn altro argomento.' },
  ];
  const blocks = segmentLessonPlayback(sources);
  const explanation = blocks.find(block => block.speech.includes('Il pedice'));
  const other = blocks.find(block => block.speech.includes('Un altro argomento'));
  if (!explanation || !other) throw new Error('Passages must be projected');
  expect(getPlaybackFormulaSources(explanation, sources)).toEqual(['$$x_i+y$$']);
  expect(getPlaybackFormulaSources(other, sources)).toEqual([]);
});

test('retains an image embedded in narrated mathematical prose', () => {
  const blocks = segmentLessonPlayback([
    {
      type: 'markdown',
      markdown: 'Consideriamo $x$ nella figura ![Figura](https://example.test/figure.png).',
    },
  ]);
  const visuals = blocks.flatMap(playbackNonProseVisuals);
  expect(
    visuals.map(visual => (visual.kind === 'markdown' ? visual.markdown : '')).join('')
  ).toContain('![Figura](https://example.test/figure.png)');
  expect(
    visuals.map(visual => (visual.kind === 'markdown' ? visual.markdown : '')).join('')
  ).not.toContain('Consideriamo');
});

test.each([
  '',
  '\n\n| Nome | Valore |\n| --- | --- |\n| i | 1 |',
])('retains the full equation through a later explanation with media %s', media => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '# Formula\n\nLa formula è\n\n$$h_i=b_i+w_i x$$\n\nIl pedice $i$ identifica la componente.\n\nLa formula combina bias e ingresso.' +
        media,
    },
  ];
  const block = segmentLessonPlayback(sources).find(block =>
    block.speech.includes('La formula combina')
  );
  if (!block) throw new Error('Continuation must be projected');
  expect(getPlaybackFormulaSources(block, sources)).toContain('$$h_i=b_i+w_i x$$');
});

test('keeps display context across source blocks containing inline references', () => {
  const sources = [
    { type: 'markdown' as const, markdown: '# Formula\n\nLa formula è\n\n$$h_i=b_i+w_i x$$' },
    {
      type: 'markdown' as const,
      markdown: 'Il pedice $i$ identifica la componente.\n\nLa formula combina bias e ingresso.',
    },
  ];
  const block = segmentLessonPlayback(sources).find(block =>
    block.speech.includes('La formula combina')
  );
  if (!block) throw new Error('Continuation must be projected');
  expect(getPlaybackFormulaSources(block, sources)).toContain('$$h_i=b_i+w_i x$$');
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

test.each([
  '',
  '\u007f',
  '\u001b[31m',
])('ends inherited formula context at a control-prefixed heading: %j', control => {
  const sources = [
    { type: 'markdown' as const, markdown: 'Previous explanation.\n\n$$a=b$$' },
    {
      type: 'markdown' as const,
      markdown: `${control}# Another topic\n\nAn independent explanation.`,
    },
  ];
  const block = segmentLessonPlayback(sources).find(candidate =>
    candidate.speech.includes('independent')
  );
  if (!block) throw new Error('Explanation must be projected');
  expect(getPlaybackFormulaSources(block, sources)).toEqual([]);
});

test.each([
  '',
  '\u007f',
  '\u001b[31m',
])('keeps a complete formula group across rendering controls: %j', control => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: `Previous explanation.\n\n$$a=b$$\n\n${control}$$c=d$$`,
    },
    { type: 'markdown' as const, markdown: 'Explain both equations.' },
  ];
  const block = segmentLessonPlayback(sources).find(candidate =>
    candidate.speech.includes('Explain')
  );
  if (!block) throw new Error('Explanation must be projected');
  expect(getPlaybackFormulaSources(block, sources)).toEqual(['$$a=b$$', '$$c=d$$']);
});
