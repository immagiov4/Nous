import type { PlaybackRange } from './lessonPlayback';

/** Acoustic word onsets in seconds, in canonical narration order. */
export type PlaybackWordAlignment =
  | { readonly status: 'aligned'; readonly onsets: readonly number[] }
  | { readonly status: 'failed' };

export const narrationWords = (speech: string) =>
  Array.from(speech.matchAll(/\S+/gu), match => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

/** Reject incomplete or unordered external timing instead of attaching it to other words. */
export function alignedWordTimes(
  speech: string,
  duration: number,
  alignment?: PlaybackWordAlignment
) {
  const words = narrationWords(speech);
  if (
    alignment?.status !== 'aligned' ||
    alignment.onsets.length !== words.length ||
    alignment.onsets.some(
      (time, index, onsets) =>
        !Number.isFinite(time) ||
        time < 0 ||
        time > duration ||
        (index > 0 && time < onsets[index - 1])
    )
  )
    return undefined;
  return words.map((word, index) => ({
    ...word,
    onset: alignment.onsets[index],
    endTime: alignment.onsets[index + 1] ?? duration,
  }));
}

/** All acoustic consumers resolve UTF-16 narration spans against the same recording. */
export function alignedRangeTime(
  words: NonNullable<ReturnType<typeof alignedWordTimes>>,
  range: PlaybackRange
) {
  const first = words.find(word => word.end > range.start);
  const last = words.reduce<(typeof words)[number] | undefined>(
    (last, word) => (word.start < range.end ? word : last),
    undefined
  );
  if (!first || !last) throw new Error('Timing range must overlap canonical narration.');
  return { start: first.onset, end: last.endTime };
}

export function alignedWordIndex(
  words: NonNullable<ReturnType<typeof alignedWordTimes>>,
  time: number
) {
  // Upper bound retains occurrence identity even when adjacent fragments share an onset.
  let low = 0;
  let high = words.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (words[middle].onset <= time) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}
