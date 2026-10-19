// @vitest-environment jsdom
import { deriveLegacyLessonContent } from '@shared/lessonContent';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { expect, test } from 'vitest';
import { applySectionAnnotation } from '../../../utils/learning/sectionAnnotations.ts';
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
