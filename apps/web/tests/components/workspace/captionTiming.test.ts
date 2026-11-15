import { alignedWordTimes, narrationWords } from '@shared/playbackWordTiming';
import { expect, test } from 'vitest';
import {
  type CaptionTimingClock,
  createCaptionTiming,
} from '../../../components/workspace/playback/captionTiming.ts';

const speech = 'Alpha beta gamma delta';

test('paragraph fill leads aligned words by 200 ms without starting before the paragraph', () => {
  let heard = -1;
  const current = { ...clock(0, [0, 2, 4, 6]), read: () => ({ blockTime: heard }) };
  const owner = createCaptionTiming(speech, { words: narrationWords(speech) });
  expect(owner.fill(current)).toEqual([0, 0, 0, 0]);
  const coincident = createCaptionTiming(speech, { words: narrationWords(speech) });
  expect(coincident.fill(clock(-1, [0, 0, 0, 0]))).toEqual([0, 0, 0, 0]);
  heard = 0;
  expect(owner.fill(current)).toEqual([0, 0, 0, 0]);
  heard = 1.9;
  expect(owner.fill(current)).toEqual([1, expect.closeTo(0.05), 0, 0]);
  heard = 10;
  expect(owner.fill(current)).toEqual([1, 1, 1, 1]);
});

test('explicit seeks reconstruct at their target and restore the lead only as audio advances', () => {
  let heard = 5;
  const current = { ...clock(0, [0, 2, 4, 6]), read: () => ({ blockTime: heard }) };
  const owner = createCaptionTiming(speech, { words: narrationWords(speech) });
  owner.fill(current);
  heard = 1.9;
  const seek = { ...current, seekRevision: 1 };
  expect(owner.fill(seek)).toEqual([expect.closeTo(0.95), 0, 0, 0]);
  expect(owner.fill(seek)).toEqual([expect.closeTo(0.95), 0, 0, 0]);
  heard = 2;
  expect(owner.fill(seek)).toEqual([1, expect.closeTo(0.05), 0, 0]);
  heard = 2.1;
  expect(owner.fill(seek)).toEqual([1, expect.closeTo(0.15), 0, 0]);
  expect(owner.fill({ ...seek })).toEqual([1, expect.closeTo(0.15), 0, 0]);
});

test('a seek into a new paragraph starts at the target without presenting later words', () => {
  const owner = createCaptionTiming(speech, { words: narrationWords(speech) });
  expect(owner.fill({ ...clock(1.9, [0, 2, 4, 6]), seekRevision: 2 })).toEqual([
    expect.closeTo(0.95),
    0,
    0,
    0,
  ]);
});
function clock(time: number, onsets?: number[]): CaptionTimingClock {
  return {
    runs: [0, 1, 2, 3].map(index => ({ start: index * 100, width: 100 })),
    width: 400,
    bodyDuration: 8,
    headingDuration: 2,
    speechRanges: narrationWords(speech),
    seekRevision: 0,
    aligned: onsets && alignedWordTimes(speech, 10, { status: 'aligned', onsets }),
    read: () => ({ blockTime: time }),
  };
}

test('estimated word spans include the heading but exclude the reveal feather and lead', () => {
  const owner = createCaptionTiming(speech, { anchors: ['beta', 'delta'] });
  expect(owner.read(clock(0)).spans).toEqual([
    { startMs: 4000, endMs: 6000 },
    { startMs: 8000, endMs: 10000 },
  ]);
});

test('late timing retains heard boundaries, updates future boundaries, and explicit seeks adopt all', () => {
  const owner = createCaptionTiming(speech, { anchors: ['beta', 'delta'] });
  owner.read(clock(4));
  const late = clock(4, [0, 5, 7, 9]);
  expect(owner.read(late).spans).toEqual([
    { startMs: 4000, endMs: 7000 },
    { startMs: 9000, endMs: 10000 },
  ]);
  expect(owner.snapshot()).toEqual({ reason: 'refresh', heardMs: 4000, retained: 1 });
  expect(owner.read({ ...late, seekRevision: 1 }).spans[0]).toEqual({ startMs: 5000, endMs: 7000 });
  expect(owner.snapshot()).toEqual({ reason: 'seek', heardMs: 4000, retained: 0 });
});

test('remeasure preserves presented spans but recalculates upcoming words', () => {
  const owner = createCaptionTiming(speech, { anchors: ['beta', 'delta'] });
  owner.read(clock(6));
  const measured = {
    ...clock(6),
    runs: [
      { start: 0, width: 200 },
      { start: 200, width: 100 },
      { start: 300, width: 50 },
      { start: 350, width: 50 },
    ],
  };
  expect(owner.read(measured).spans).toEqual([
    { startMs: 4000, endMs: 6000 },
    { startMs: 9000, endMs: 10000 },
  ]);
});

test('live forward and backward time reads reuse timing until a clock replacement', () => {
  let heard = 4;
  const current = { ...clock(0), read: () => ({ blockTime: heard }) };
  const owner = createCaptionTiming(speech, { anchors: ['beta'] });
  const first = owner.read(current);
  heard = 9;
  expect(owner.read(current)).toBe(first);
  heard = 1;
  expect(owner.read(current)).toBe(first);
  const replacement = { ...current, aligned: clock(0, [0, 5, 7, 9]).aligned, seekRevision: 1 };
  expect(owner.read(replacement).cueTimes).toEqual([5000]);
  expect(owner.snapshot()?.heardMs).toBe(1000);
});

test.each([
  false,
  true,
])('presented motion keeps its complete duration, including item ranges (%s)', itemRanges => {
  const owner = createCaptionTiming(
    speech,
    itemRanges
      ? { itemRanges: [{ start: 6, end: 10 }] }
      : { events: [{ effect: 'focus', quote: 'beta', targets: ['item:0'] }] }
  );
  const first = owner.read(clock(4)).events[0];
  const updated = owner.read(clock(4, [0, 5, 9, 9.5])).events[0];
  expect(updated.atMs).toBe(first.atMs);
  expect(updated.durationMs).toBe(first.durationMs);
  const sought = owner.read({ ...clock(4, [0, 5, 9, 9.5]), seekRevision: 1 }).events[0];
  expect(sought.atMs).toBe(5000);
  expect(sought.durationMs).toBe(4000);
});

test('visual ranges take precedence over anchors and unquoted visuals retain fallback selection', () => {
  const owner = createCaptionTiming(speech, {
    visuals: [{ range: { start: 6, end: 10 }, anchors: ['delta'] }, { anchors: ['delta'] }, {}],
  });
  expect(owner.read(clock(0)).spans).toEqual([
    { startMs: 4000, endMs: 6000 },
    { startMs: 8000, endMs: 10000 },
    undefined,
  ]);
});

test('adopts overdue acoustic cues instead of waiting for a future estimate', () => {
  const owner = createCaptionTiming(speech, { anchors: ['delta'] });
  expect(owner.read(clock(5)).cueTimes).toEqual([8000]);
  expect(owner.read(clock(5, [0, 1, 2, 3])).cueTimes).toEqual([3000]);
});

test.each([
  {
    source: 'aligned refresh',
    time: 1.9,
    before: [0, 2, 4, 6],
    after: [0, 3, 4, 6],
    atSeek: 1.9 / 3,
  },
  { source: 'estimated timing', time: 3.9, before: undefined, after: [0, 5, 6, 8], atSeek: 0.78 },
])('completed words stay full after $source until an explicit seek', ({
  time,
  before,
  after,
  atSeek,
}) => {
  const owner = createCaptionTiming(speech, { words: narrationWords(speech) });
  expect(owner.fill(clock(time, before))[0]).toBe(1);
  const late = clock(time, after);
  expect(owner.fill(late)[0]).toBe(1);
  expect(owner.fill({ ...late, seekRevision: 1 })[0]).toBeCloseTo(atSeek);
});

test('fill uses one live sample for its seek boundary and presentation', () => {
  const owner = createCaptionTiming(speech, { words: narrationWords(speech) });
  owner.fill(clock(1, [0, 2, 4, 6]));
  let reads = 0;
  const sought = {
    ...clock(1.9, [0, 2, 4, 6]),
    seekRevision: 1,
    read: () => ({ blockTime: ++reads === 1 ? 1.9 : 5 }),
  };
  expect(owner.fill(sought)).toEqual([expect.closeTo(0.95), 0, 0, 0]);
  expect(reads).toBe(1);
});
