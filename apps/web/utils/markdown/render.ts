import { planMarkdownFencedCode, stripHighlightTagsInsideMarkdownCode } from './codeRanges.ts';
import { processMarkdownSegment } from './segment.ts';

const DELETE_CONTROL_CHARACTER = '\u007f';
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

export const normalizeMarkdownForRendering = (content: string): string => {
  const normalizedContent = stripHighlightTagsInsideMarkdownCode(
    content
      .replaceAll(ANSI_ESCAPE_SEQUENCE, '')
      .replaceAll(DELETE_CONTROL_CHARACTER, '')
      .replaceAll(/\r/g, '')
  );
  const fencedCodePlan = planMarkdownFencedCode(normalizedContent);
  const unclosedFenceStarts = fencedCodePlan.unclosedRanges.map(range => {
    const openingLineEnd = normalizedContent.indexOf('\n', range.start);
    const openingLine = normalizedContent.slice(
      range.start,
      openingLineEnd === -1 ? normalizedContent.length : openingLineEnd
    );
    const fenceOffset = openingLine.search(/[`~]/u);
    return range.start + Math.max(fenceOffset, 0);
  });
  const events = [
    ...fencedCodePlan.closedRanges.map(range => ({ ...range, type: 'closed' as const })),
    ...unclosedFenceStarts.map(start => ({ end: start, start, type: 'unclosed' as const })),
  ].sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let cursor = 0;

  for (const event of events) {
    if (event.start < cursor) {
      continue;
    }

    parts.push(processMarkdownSegment(normalizedContent.slice(cursor, event.start)));
    if (event.type === 'unclosed') {
      parts.push('\\');
      cursor = event.start;
      continue;
    }

    parts.push(normalizedContent.slice(event.start, event.end));
    cursor = event.end;
  }

  parts.push(processMarkdownSegment(normalizedContent.slice(cursor)));

  return parts.join('');
};
