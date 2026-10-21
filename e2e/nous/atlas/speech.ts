import type { MarkdownAnalysis } from '../../../apps/web/utils/markdown/codeRanges';
import type {
  LessonPlaybackBlock,
  PlaybackRange,
  PlaybackTextSpan,
} from '../../../packages/shared-types/lessonPlayback';
import type { AtlasFinding } from './checks';

type MappedSpan = PlaybackTextSpan & { blockId: string };
interface SpeechProjection {
  block: LessonPlaybackBlock;
  blocks: readonly LessonPlaybackBlock[];
  sources: readonly { sourceBlockIndex: number; markdown: string; analysis: MarkdownAnalysis }[];
}

function omittedMath(input: {
  block: LessonPlaybackBlock;
  spans: readonly MappedSpan[];
  sourceBlockIndex: number;
  range: PlaybackRange;
  markdown: string;
}): AtlasFinding[] {
  const { block, spans, sourceBlockIndex, range, markdown } = input;
  const sourceSpans = spans.filter(mapped => mapped.sourceBlockIndex === sourceBlockIndex);
  if (
    sourceSpans.some(mapped => mapped.source.start < range.end && mapped.source.end > range.start)
  )
    return [];
  // Source block and UTF-16 offset define the authored reading order.
  const before = [...spans]
    .reverse()
    .find(
      mapped => (mapped.sourceBlockIndex - sourceBlockIndex || mapped.source.end - range.start) <= 0
    );
  const after = spans.find(
    mapped => (mapped.sourceBlockIndex - sourceBlockIndex || mapped.source.start - range.end) >= 0
  );
  const adjacentBlockIds = [
    ...new Set([before?.blockId, after?.blockId].filter((id): id is string => id !== undefined)),
  ];
  if (!adjacentBlockIds.includes(block.id)) return [];
  const speechGap = {
    start: before?.blockId === block.id ? before.speech.end : 0,
    end: after?.blockId === block.id ? after.speech.start : block.speech.length,
  };
  return [
    {
      kind: 'speech-inline-math-omitted',
      detail: {
        markdown,
        sourceBlockIndex,
        source: range,
        adjacentBlockIds,
        speechGap,
        gapText: block.speech.slice(speechGap.start, speechGap.end),
      },
    },
  ];
}

/** Inspect original sources; gaps between blocks are attributed to both adjacent spoken blocks. */
export function speechMathFindings({ block, blocks, sources }: SpeechProjection): AtlasFinding[] {
  const spans = blocks
    .flatMap(candidate => candidate.spans.map(span => ({ ...span, blockId: candidate.id })))
    .filter(span => span.source.start < span.source.end && span.speech.start < span.speech.end)
    .sort(
      (left, right) =>
        left.sourceBlockIndex - right.sourceBlockIndex || left.source.start - right.source.start
    );
  return sources.flatMap(({ sourceBlockIndex, markdown: source, analysis }) => {
    const hidden = [
      ...analysis.imageRanges,
      ...analysis.linkDestinationRanges,
      ...analysis.htmlSyntaxRanges,
      ...analysis.referenceDefinitionRanges,
    ];
    return analysis.mathRanges.flatMap(range => {
      const markdown = source.slice(range.start, range.end);
      if (markdown.startsWith('$$') || markdown.startsWith(String.raw`\[`)) return [];
      if (
        hidden.some(hiddenRange => hiddenRange.start < range.end && hiddenRange.end > range.start)
      )
        return [];
      return omittedMath({ block, spans, sourceBlockIndex, range, markdown });
    });
  });
}

/** Raw punctuation-only tokens require interpretation; they never determine pass/fail. */
export function speechPunctuationTokens(speech: string) {
  return Array.from(speech.matchAll(/\S+/gu))
    .filter(token => /^[\p{P}\p{S}]+$/u.test(token[0]))
    .map(token => ({ text: token[0], start: token.index, end: token.index + token[0].length }));
}
