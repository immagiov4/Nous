import {
  type MarkdownRange,
  parseMarkdownAnalysis,
  planMarkdownFencedCode,
  projectUnclosedMarkdownFenceOpeners,
  stripHighlightTagsInsideMarkdownCode,
} from './codeRanges.ts';
import { escapeDisallowedRawHtml } from './html.ts';
import { processMarkdownSegment } from './segment.ts';

const DELETE_CONTROL_CHARACTER = '\u007f';
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

const escapeDisallowedRawHtmlOutsideCode = (
  content: string,
  codeRanges: readonly MarkdownRange[],
  start: number,
  end: number
): string => {
  const parts: string[] = [];
  let cursor = start;
  for (const range of codeRanges) {
    if (range.end <= cursor) continue;
    if (range.start >= end) break;
    const protectedStart = Math.max(cursor, range.start);
    const protectedEnd = Math.min(end, range.end);
    parts.push(escapeDisallowedRawHtml(content.slice(cursor, protectedStart)));
    parts.push(content.slice(protectedStart, protectedEnd));
    cursor = protectedEnd;
  }
  parts.push(escapeDisallowedRawHtml(content.slice(cursor, end)));
  return parts.join('');
};

const getProjectedOffset = (
  sourceOffset: number,
  escapedOpenerRanges: readonly MarkdownRange[]
): number => sourceOffset + escapedOpenerRanges.filter(range => range.start < sourceOffset).length;

export const normalizeMarkdownForRendering = (content: string): string => {
  const normalizedContent = stripHighlightTagsInsideMarkdownCode(
    content
      .replaceAll(ANSI_ESCAPE_SEQUENCE, '')
      .replaceAll(DELETE_CONTROL_CHARACTER, '')
      .replaceAll(/\r/g, '')
  );
  const fencedCodePlan = planMarkdownFencedCode(normalizedContent);
  const events = [
    ...fencedCodePlan.closedRanges.map(range => ({ ...range, type: 'closed' as const })),
    ...fencedCodePlan.unclosedRanges.map(range => ({ ...range, type: 'unclosed' as const })),
  ].sort((left, right) => left.start - right.start);
  const fenceProjection = fencedCodePlan.unclosedRanges.length
    ? projectUnclosedMarkdownFenceOpeners(normalizedContent)
    : { content: normalizedContent, escapedOpenerRanges: [] };
  const escapedOpenerRanges = fenceProjection.escapedOpenerRanges.sort(
    (left, right) => left.start - right.start
  );
  const projectedContent = fenceProjection.content;
  const projectedCodeRanges = fencedCodePlan.unclosedRanges.length
    ? parseMarkdownAnalysis(projectedContent).codeRanges
    : [];
  const parts: string[] = [];
  let cursor = 0;

  for (const event of events) {
    const start = getProjectedOffset(event.start, escapedOpenerRanges);
    const end = getProjectedOffset(event.end, escapedOpenerRanges);
    if (start < cursor) continue;

    parts.push(processMarkdownSegment(projectedContent.slice(cursor, start)));
    parts.push(
      event.type === 'closed'
        ? projectedContent.slice(start, end)
        : escapeDisallowedRawHtmlOutsideCode(projectedContent, projectedCodeRanges, start, end)
    );
    cursor = end;
  }

  parts.push(processMarkdownSegment(projectedContent.slice(cursor)));

  return parts.join('');
};
