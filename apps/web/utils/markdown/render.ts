import {
  escapeUnclosedMarkdownFenceOpeners,
  parseMarkdownAnalysis,
  planMarkdownFencedCode,
  stripHighlightTagsInsideMarkdownCode,
} from './codeRanges.ts';
import { escapeDisallowedRawHtml } from './html.ts';
import { processMarkdownSegment } from './segment.ts';

const DELETE_CONTROL_CHARACTER = '\u007f';
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

const escapeDisallowedRawHtmlOutsideCode = (content: string): string => {
  const parts: string[] = [];
  let cursor = 0;
  for (const range of parseMarkdownAnalysis(content).codeRanges) {
    if (range.start < cursor) continue;
    parts.push(escapeDisallowedRawHtml(content.slice(cursor, range.start)));
    parts.push(content.slice(range.start, range.end));
    cursor = range.end;
  }
  parts.push(escapeDisallowedRawHtml(content.slice(cursor)));
  return parts.join('');
};

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
  const parts: string[] = [];
  let cursor = 0;

  for (const event of events) {
    if (event.start < cursor) {
      continue;
    }

    parts.push(processMarkdownSegment(normalizedContent.slice(cursor, event.start)));
    if (event.type === 'unclosed') {
      const escapedUnclosedRange = escapeUnclosedMarkdownFenceOpeners(
        normalizedContent.slice(event.start, event.end)
      );
      parts.push(escapeDisallowedRawHtmlOutsideCode(escapedUnclosedRange));
      cursor = event.end;
      continue;
    }

    parts.push(normalizedContent.slice(event.start, event.end));
    cursor = event.end;
  }

  parts.push(processMarkdownSegment(normalizedContent.slice(cursor)));

  return parts.join('');
};
