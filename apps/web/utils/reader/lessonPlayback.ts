import { deriveLegacyLessonContent } from '@shared/lessonContent';
import type { LessonPlaybackBlock, PlaybackContentBlock } from '@shared/lessonPlayback';
import { createSectionAnnotationSelector } from '../learning/sectionAnnotationAnchors.ts';
import { buildVisibleProjection } from '../markdown/textProjection.ts';

export const playbackWords = (speech: string) =>
  Array.from(speech.matchAll(/\S+/gu), match => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

/** The block duration is measured; word positions within it are estimates, as in the lab. */
export const playbackWordIndex = (count: number, time: number, duration: number) =>
  duration > 0 ? Math.min(count - 1, Math.floor((Math.max(0, time) / duration) * count)) : 0;

/** Same estimate as the listening prototype; measured recordings progressively replace it. */
export function playbackTimeline(blocks: readonly LessonPlaybackBlock[], voice: string) {
  const fallbackWordsPerMinute = 240;
  const counts = blocks.map(block => playbackWords(block.speech).length);
  const recordings = blocks.map(block => block.audio.find(audio => audio.voice === voice));
  const knownWords = recordings.reduce((sum, audio, index) => sum + (audio ? counts[index] : 0), 0);
  const knownSeconds = recordings.reduce((sum, audio) => sum + (audio?.durationSeconds ?? 0), 0);
  const secondsPerWord = knownWords ? knownSeconds / knownWords : 60 / fallbackWordsPerMinute;
  return recordings.map((audio, index) => ({
    duration: audio?.durationSeconds ?? counts[index] * secondsPerWord,
    estimated: !audio,
  }));
}

/** Maps the current sentence through source spans to the reader's annotation selector. */
export function playbackSentenceSelector(
  block: LessonPlaybackBlock,
  time: number,
  duration: number,
  contentBlocks: readonly PlaybackContentBlock[]
) {
  const words = playbackWords(block.speech);
  const offset = words[playbackWordIndex(words.length, time, duration)]?.start ?? 0;
  const sentences = Array.from(
    new Intl.Segmenter('it', { granularity: 'sentence' }).segment(block.speech)
  );
  const sentence = sentences.find(
    part => offset >= part.index && offset < part.index + part.segment.length
  );
  if (!sentence) return null;
  const sentenceEnd = sentence.index + sentence.segment.length;
  const content = deriveLegacyLessonContent(contentBlocks);
  const ranges = block.spans.flatMap(span => {
    const start = Math.max(sentence.index, span.speech.start);
    const end = Math.min(sentenceEnd, span.speech.end);
    if (start >= end || span.source.start === span.source.end) return [];
    const source = contentBlocks[span.sourceBlockIndex];
    if (source.type !== 'markdown') return [];
    const before = deriveLegacyLessonContent(contentBlocks.slice(0, span.sourceBlockIndex));
    const base =
      (before ? before.length + '\n\n'.length : 0) -
      (source.markdown.length - source.markdown.trimStart().length);
    return [
      {
        start: base + span.source.start + start - span.speech.start,
        end: base + span.source.start + end - span.speech.start,
      },
    ];
  });
  const projection = buildVisibleProjection(content);
  const selector = createSectionAnnotationSelector(content, ranges, projection);
  return selector
    ? {
        ...selector,
        selectionStart: projection.sourceIndexes.findIndex(index => index >= selector.start),
      }
    : null;
}
