import { deriveLegacyLessonContent } from '@shared/lessonContent';
import {
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
  resolvePlaybackNarration,
} from '@shared/lessonPlayback';
import {
  alignedWordIndex,
  alignedWordTimes,
  narrationWords,
  type PlaybackWordAlignment,
} from '@shared/playbackWordTiming';
import { createSectionAnnotationSelector } from '../learning/sectionAnnotationAnchors.ts';
import { buildVisibleProjection } from '../markdown/textProjection.ts';

export const playbackWords = narrationWords;

/** Adopt only timing for identical recorded narration; retain mounted content and decoded audio. */
export function mergeRecordingAlignment(
  saved: LessonPlaybackBlock,
  incoming: LessonPlaybackBlock | undefined
) {
  if (
    incoming?.id !== saved.id ||
    resolvePlaybackNarration(incoming).speech !== resolvePlaybackNarration(saved).speech
  )
    return saved;
  let changed = false;
  const audio = saved.audio.map(recording => {
    if (recording.wordAlignment) return recording;
    const next = incoming.audio.find(
      next =>
        next.asset.id === recording.asset.id &&
        next.asset.hash === recording.asset.hash &&
        next.model === recording.model &&
        next.voice === recording.voice
    );
    if (!next?.wordAlignment) return recording;
    changed = true;
    return { ...recording, wordAlignment: next.wordAlignment };
  });
  return changed ? { ...saved, audio } : saved;
}

/** The block duration is measured; word positions within it are estimates, as in the lab. */
export const playbackWordIndex = (count: number, time: number, duration: number) =>
  duration > 0 ? Math.min(count - 1, Math.floor((Math.max(0, time) / duration) * count)) : 0;

/** Same estimate as the listening prototype; measured recordings progressively replace it. */
export function playbackTimeline(
  blocks: readonly LessonPlaybackBlock[],
  voice: string,
  model?: string
) {
  const fallbackWordsPerMinute = 240;
  const counts = blocks.map(block => playbackWords(resolvePlaybackNarration(block).speech).length);
  const recordings = blocks.map(block =>
    block.audio.find(audio => audio.voice === voice && (!model || audio.model === model))
  );
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
  sourceBlock: LessonPlaybackBlock,
  time: number,
  duration: number,
  contentBlocks: readonly PlaybackContentBlock[],
  alignment?: PlaybackWordAlignment
) {
  const block = resolvePlaybackNarration(sourceBlock);
  const words = playbackWords(block.speech);
  const aligned = alignedWordTimes(block.speech, duration, alignment);
  const offset =
    words[
      aligned ? alignedWordIndex(aligned, time) : playbackWordIndex(words.length, time, duration)
    ]?.start ?? 0;
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
        start:
          base + span.source.start + (span.math || span.fencedCode ? 0 : start - span.speech.start),
        end:
          base +
          (span.math || span.fencedCode
            ? span.source.end
            : span.source.start + end - span.speech.start),
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
