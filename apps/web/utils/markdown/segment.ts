import { escapeDisallowedRawHtml } from './html.ts';
import { removeAccidentalPlainTextIndentation } from './indentation.ts';
import {
  getDisplayMathClosingDelimiter,
  normalizeMathMarkdownSegment,
} from './mathNormalization.ts';

const processNormalizedMarkdownSegment = (segment: string): string => {
  const lines = normalizeMathMarkdownSegment(segment).replaceAll('\r', '').split('\n');
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const displayMathClosingDelimiter = getDisplayMathClosingDelimiter(line);
    if (displayMathClosingDelimiter) {
      output.push(line);
      index += 1;

      while (index < lines.length) {
        const candidateLine = lines[index];
        output.push(candidateLine);
        if (candidateLine.trim() === displayMathClosingDelimiter) {
          break;
        }
        index += 1;
      }
      continue;
    }

    const parts = line.split(/(`[^`]+`)/);
    output.push(
      parts
        .map((part, partIndex) => (partIndex % 2 === 1 ? part : escapeDisallowedRawHtml(part)))
        .join('')
    );
  }

  return output.join('\n');
};

export const processMarkdownSegment = (segment: string): string =>
  processNormalizedMarkdownSegment(removeAccidentalPlainTextIndentation(segment));

export const processMarkdownSegmentPreservingIndentation = (segment: string): string =>
  processNormalizedMarkdownSegment(segment);
