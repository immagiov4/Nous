import {
  type MarkdownRange,
  MIN_MARKDOWN_FENCE_LENGTH,
  parseMarkdownAnalysis,
  planMarkdownFencedCode,
  projectUnclosedMarkdownFenceOpeners,
  stripHighlightTagsInsideMarkdownCode,
} from './codeRanges.ts';
import { processMarkdownSegment, processMarkdownSegmentPreservingIndentation } from './segment.ts';

const DELETE_CONTROL_CHARACTER = '\u007f';
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const MARKDOWN_LINE_ENDING_PATTERN = /\r\n?/gu;
const POTENTIAL_MARKDOWN_FENCE_PATTERN = new RegExp(
  `\`{${MIN_MARKDOWN_FENCE_LENGTH},}|~{${MIN_MARKDOWN_FENCE_LENGTH},}`,
  'u'
);

const introducesPotentialFence = (original: string, processed: string): boolean =>
  processed !== original && POTENTIAL_MARKDOWN_FENCE_PATTERN.test(processed);

const processMarkdownRangeOutsideCode = (
  content: string,
  codeRanges: readonly MarkdownRange[],
  bounds?: MarkdownRange,
  processSegment = processMarkdownSegment
): string => {
  const rangeStart = bounds?.start ?? 0;
  const rangeEnd = bounds?.end ?? content.length;
  const parts: string[] = [];
  let cursor = rangeStart;
  for (const range of codeRanges) {
    if (range.end <= cursor) continue;
    if (range.start >= rangeEnd) break;
    const protectedStart = Math.max(cursor, range.start);
    const protectedEnd = Math.min(rangeEnd, range.end);
    parts.push(
      processSegment(content.slice(cursor, protectedStart)),
      content.slice(protectedStart, protectedEnd)
    );
    cursor = protectedEnd;
  }
  parts.push(processSegment(content.slice(cursor, rangeEnd)));
  return parts.join('');
};

const processMarkdownOutsideCode = (content: string): string => {
  if (!POTENTIAL_MARKDOWN_FENCE_PATTERN.test(content)) return processMarkdownSegment(content);
  const codeRanges = parseMarkdownAnalysis(content).codeRanges;
  if (codeRanges.length === 0) return processMarkdownSegment(content);
  return processMarkdownRangeOutsideCode(content, codeRanges);
};

const getProjectedOffset = (
  sourceOffset: number,
  escapedOpenerRanges: readonly MarkdownRange[]
): number =>
  sourceOffset +
  escapedOpenerRanges.reduce(
    (insertedEscapeCount, range) =>
      range.start < sourceOffset
        ? insertedEscapeCount + range.end - range.start
        : insertedEscapeCount,
    0
  );

export const normalizeMarkdownForRendering = (content: string): string => {
  const normalizedContent = stripHighlightTagsInsideMarkdownCode(
    content
      .replaceAll(ANSI_ESCAPE_SEQUENCE, '')
      .replaceAll(DELETE_CONTROL_CHARACTER, '')
      .replaceAll(MARKDOWN_LINE_ENDING_PATTERN, '\n')
  );
  const fencedCodePlan = planMarkdownFencedCode(normalizedContent);
  const events = [
    ...fencedCodePlan.closedRanges.map(range => ({ ...range, type: 'closed' as const })),
    ...fencedCodePlan.unclosedRanges.map(range => ({ ...range, type: 'unclosed' as const })),
  ].sort((left, right) => left.start - right.start);
  const fenceProjection = fencedCodePlan.unclosedRanges.length
    ? projectUnclosedMarkdownFenceOpeners(normalizedContent)
    : { codeRanges: [], content: normalizedContent, escapedOpenerRanges: [] };
  const escapedOpenerRanges = fenceProjection.escapedOpenerRanges.sort(
    (left, right) => left.start - right.start
  );
  const projectedContent = fenceProjection.content;
  const projectedCodeRanges = fenceProjection.codeRanges;
  const parts: string[] = [];
  let cursor = 0;
  let shouldReplanAfterSegmentProcessing = false;

  for (const event of events) {
    const start = getProjectedOffset(event.start, escapedOpenerRanges);
    const end = getProjectedOffset(event.end, escapedOpenerRanges);
    if (start < cursor) continue;

    const segment = projectedContent.slice(cursor, start);
    const processedSegment = processMarkdownOutsideCode(segment);
    if (introducesPotentialFence(segment, processedSegment)) {
      shouldReplanAfterSegmentProcessing = true;
    }
    parts.push(processedSegment);
    if (event.type === 'closed') {
      parts.push(projectedContent.slice(start, end));
      cursor = end;
      continue;
    }

    const unclosedContent = projectedContent.slice(start, end);
    const processedUnclosedContent = processMarkdownRangeOutsideCode(
      projectedContent,
      projectedCodeRanges,
      { start, end },
      processMarkdownSegmentPreservingIndentation
    );
    if (introducesPotentialFence(unclosedContent, processedUnclosedContent)) {
      shouldReplanAfterSegmentProcessing = true;
    }
    parts.push(processedUnclosedContent);
    cursor = end;
  }

  const trailingSegment = projectedContent.slice(cursor);
  const processedTrailingSegment = processMarkdownOutsideCode(trailingSegment);
  if (introducesPotentialFence(trailingSegment, processedTrailingSegment)) {
    shouldReplanAfterSegmentProcessing = true;
  }
  parts.push(processedTrailingSegment);

  const renderedContent = parts.join('');
  return shouldReplanAfterSegmentProcessing
    ? projectUnclosedMarkdownFenceOpeners(renderedContent).content
    : renderedContent;
};
