import { alignedRangeTime, alignedWordIndex, alignedWordTimes } from '@shared/playbackWordTiming';
import { expect, test } from 'vitest';

test('keeps repeated Italian mathematical words distinct through forward and backward seek', () => {
  const speech = 'ics più ics uguale due ics';
  const times = alignedWordTimes(speech, 4, {
    status: 'aligned',
    onsets: [0.2, 0.6, 1.1, 1.8, 2.3, 3],
  });
  expect(times).toBeDefined();
  if (!times) throw new Error('Expected complete alignment');
  expect(alignedRangeTime(times, { start: 8, end: 11 })).toEqual({ start: 1.1, end: 1.8 });
  expect(alignedWordIndex(times, 3.2)).toBe(5);
  expect(alignedWordIndex(times, 0.7)).toBe(1);
});

test.each([
  [0.1],
  [0.4, 0.2],
  [-1, 0.3],
  [0.1, 4],
  [0.1, Number.NaN],
])('declines unusable alignment %j so consumers retain their estimated clock', (...onsets) => {
  expect(alignedWordTimes('due parole', 2, { status: 'aligned', onsets })).toBeUndefined();
});
