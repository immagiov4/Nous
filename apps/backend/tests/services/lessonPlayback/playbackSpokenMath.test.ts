import {
  hasOmittedPlaybackMath,
  resolvePlaybackNarration,
  segmentLessonPlayback,
  validatePlaybackSpokenMath,
} from '@shared/lessonPlayback';
import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  captionFormat,
  captionSource,
  captionSpeechRanges,
} from '../../../../web/components/workspace/playback/captionFormat';
import { discreteMathCases } from '../../helpers/discreteMath';

const { structured } = vi.hoisted(() => ({ structured: vi.fn() }));
vi.mock('../../../src/services/structuredGeneration.js', () => ({
  generateStructuredOutput: structured,
}));

import { getGlobalModelConfig } from '../../../src/config/modelConfig.js';
import { generatePlaybackSpokenMath } from '../../../src/services/lessonPlayback/playbackSpokenMath.js';
import { playbackAsset } from '../../helpers/lessonPlayback.js';

const source =
  String.raw`Consideriamo $p_\theta(y\mid x)$. Poi $x$, mentre \(y\) indica il risultato. Il codice ` +
  '`$z$`' +
  ' è letterale.';
const raw = () => segmentLessonPlayback([{ type: 'markdown', markdown: source }])[0];
const spokenMath = [
  { formula: String.raw`$p_\theta(y\mid x)$`, spoken: 'p con parametro theta di y dato x' },
  { formula: '$x$', spoken: 'ics' },
  { formula: String.raw`\(y\)`, spoken: 'ipsilon' },
];
beforeEach(() => vi.resetAllMocks());
test('preserves prose and source offsets while inserting every model pronunciation exactly once', () => {
  const block = raw();
  const resolved = resolvePlaybackNarration({ ...block, prepared: { motion: [], spokenMath } });
  expect(resolved.speech).toBe(
    'Consideriamo p con parametro theta di y dato x. Poi ics, mentre ipsilon indica il risultato. Il codice $z$ è letterale.'
  );
  expect(resolvePlaybackNarration(resolved)).toEqual(resolved);
  expect(
    resolved.spans
      .filter(span => span.math)
      .map(span => [
        source.slice(span.source.start, span.source.end),
        resolved.speech.slice(span.speech.start, span.speech.end),
      ])
  ).toEqual(spokenMath.map(entry => [entry.formula, entry.spoken]));
  expect(LessonPlaybackBlockSchema.parse(resolved).prepared?.spokenMath).toEqual(spokenMath);
});
test.each(
  [
    [],
    spokenMath.slice(0, 2),
    [...spokenMath, { formula: '$z$', spoken: 'zeta' }],
    [spokenMath[1], spokenMath[0], spokenMath[2]],
    [{ ...spokenMath[0], spoken: '  ' }, ...spokenMath.slice(1)],
  ].map(invalid => ({ invalid }))
)('rejects missing, extra, reordered or blank pronunciations: $invalid', ({ invalid }) => {
  expect(() => validatePlaybackSpokenMath(raw(), invalid)).toThrow('every inline formula');
});
test('keeps repeated formula occurrences separate', () => {
  const block = segmentLessonPlayback([{ type: 'markdown', markdown: 'Prima $x$, poi $x$.' }])[0];
  expect(
    resolvePlaybackNarration(block, [
      { formula: '$x$', spoken: 'ics' },
      { formula: '$x$', spoken: 'di nuovo ics' },
    ]).speech
  ).toBe('Prima ics, poi di nuovo ics.');
});
test('detects saved silent-math audio without changing its preparation or recordings', () => {
  const block = raw();
  const saved = {
    ...block,
    prepared: { motion: [] },
    audio: [{ model: 'tts', voice: 'Kore', durationSeconds: 5, asset: playbackAsset }],
  };
  expect(hasOmittedPlaybackMath(block)).toBe(false);
  expect(hasOmittedPlaybackMath(saved)).toBe(true);
  expect(resolvePlaybackNarration(saved)).toBe(saved);
  expect(hasOmittedPlaybackMath({ ...saved, prepared: { ...saved.prepared, spokenMath } })).toBe(
    false
  );
});
test('corrects incomplete model output before accepting a complete pronunciation set', async () => {
  structured.mockResolvedValueOnce({ spokenMath: [] }).mockResolvedValueOnce({ spokenMath });
  expect(
    await generatePlaybackSpokenMath({
      block: raw(),
      config: getGlobalModelConfig(),
      signal: new AbortController().signal,
    })
  ).toEqual(spokenMath);
  expect(structured).toHaveBeenCalledTimes(2);
});
test('fails explicitly after invalid pronunciations and propagates provider failures', async () => {
  const input = {
    block: raw(),
    config: getGlobalModelConfig(),
    signal: new AbortController().signal,
  };
  structured.mockResolvedValue({ spokenMath: [] });
  await expect(generatePlaybackSpokenMath(input)).rejects.toThrow('failed validation');
  structured.mockRejectedValue(new Error('Provider unavailable'));
  await expect(generatePlaybackSpokenMath(input)).rejects.toThrow('Provider unavailable');
});

test.each(
  discreteMathCases
)('keeps every $name occurrence ordered and captions anchored to the exact spoken words', async fixture => {
  const block = segmentLessonPlayback([{ type: 'markdown', markdown: fixture.markdown }])[0];
  structured.mockResolvedValue({ spokenMath: fixture.spokenMath });
  const pronunciations = await generatePlaybackSpokenMath({
    block,
    config: getGlobalModelConfig(),
    signal: new AbortController().signal,
  });
  expect(block.spans.filter(span => span.math).map(span => span.math)).toEqual(
    fixture.spokenMath.map(entry => entry.formula)
  );
  const resolved = resolvePlaybackNarration({
    ...block,
    prepared: { motion: [], spokenMath: pronunciations },
  });
  const source = captionSource(resolved, [{ type: 'markdown', markdown: fixture.markdown }]);
  const captions = captionFormat(source.markdown, source.ranges);
  const anchors = captionSpeechRanges(captions.words, source.ranges);
  expect(captions.words.map(word => word.text)).toEqual(resolved.speech.trim().split(/\s+/u));
  expect(anchors.map(range => resolved.speech.slice(range.start, range.end))).toEqual(
    captions.words.map(word => word.text)
  );
  expect(resolved.visuals).toEqual(block.visuals);
  expect(
    resolved.spans
      .filter(span => span.math)
      .map(span => resolved.speech.slice(span.speech.start, span.speech.end))
  ).toEqual(pronunciations.map(entry => entry.spoken));
  const prompt = JSON.parse(structured.mock.calls[0][0].prompt);
  expect(prompt.formulas).toEqual(fixture.spokenMath.map(entry => entry.formula));
});
