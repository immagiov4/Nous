import {
  collectCodeContinuationLines,
  countParenBalance,
  getCodeLanguageLabel,
  inferStandaloneCodeLanguage,
  isStandaloneCodeLine,
  normalizeCodeFenceSpacing,
  parseInlineCodeLead,
  transformSingleLineCodeBlock,
  trimCodeLine,
} from './codeHeuristics.ts';
import { escapeDisallowedRawHtml } from './html.ts';
import { removeAccidentalPlainTextIndentation } from './indentation.ts';
import {
  getDisplayMathClosingDelimiter,
  normalizeMathMarkdownSegment,
} from './mathNormalization.ts';

export interface MarkdownSegmentSourceRange {
  end: number;
  start: number;
}

export interface MarkdownSegmentRenderingPlan {
  markdown: string;
  synthesizedCodeRanges: MarkdownSegmentSourceRange[];
}

export const planMarkdownSegmentRendering = (segment: string): MarkdownSegmentRenderingPlan => {
  const sourceLines = segment.split('\n');
  const lines = normalizeMathMarkdownSegment(removeAccidentalPlainTextIndentation(segment))
    .replaceAll(/\r/g, '')
    .split('\n');
  const output: string[] = [];
  const synthesizedCodeRanges: MarkdownSegmentSourceRange[] = [];
  const lineStarts: number[] = [];
  let nextLineStart = 0;
  for (const line of sourceLines) {
    lineStarts.push(nextLineStart);
    nextLineStart += line.length + 1;
  }
  const recordSynthesizedCodeRange = (startIndex: number, endIndex: number) => {
    const sourceEndLine = sourceLines[endIndex] ?? '';
    synthesizedCodeRanges.push({
      start: lineStarts[startIndex] ?? 0,
      end:
        (lineStarts[endIndex] ?? 0) +
        (sourceEndLine.endsWith('\r') ? sourceEndLine.length - 1 : sourceEndLine.length),
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const displayMathClosingDelimiter = getDisplayMathClosingDelimiter(line);
    if (displayMathClosingDelimiter) {
      const mathLines = [line];
      let cursor = index + 1;

      while (cursor < lines.length) {
        const candidateLine = lines[cursor];
        mathLines.push(candidateLine);
        if (candidateLine.trim() === displayMathClosingDelimiter) {
          break;
        }
        cursor += 1;
      }

      output.push(...mathLines);
      index = cursor;
      continue;
    }

    const languageOnlyLine = getCodeLanguageLabel(line);
    if (languageOnlyLine && index + 1 < lines.length) {
      const { codeLines, lastIndex } = collectCodeContinuationLines(lines, index + 1);
      if (codeLines.length > 0) {
        recordSynthesizedCodeRange(index, lastIndex);
        output.push(
          ...normalizeCodeFenceSpacing([`\`\`\`${languageOnlyLine}`, ...codeLines, '```'])
        );
        index = lastIndex;
        continue;
      }
    }

    const inlineCodeLead = parseInlineCodeLead(line);
    if (inlineCodeLead && index + 1 < lines.length) {
      const { codeLines, lastIndex } = collectCodeContinuationLines(
        lines,
        index + 1,
        countParenBalance(inlineCodeLead.code)
      );
      if (codeLines.length > 0) {
        recordSynthesizedCodeRange(index, lastIndex);
        output.push(
          ...normalizeCodeFenceSpacing([
            `\`\`\`${inlineCodeLead.language}`,
            inlineCodeLead.code,
            ...codeLines,
            '```',
          ])
        );
        index = lastIndex;
        continue;
      }
    }

    const transformedSingleLineCode = transformSingleLineCodeBlock(line);
    if (transformedSingleLineCode) {
      recordSynthesizedCodeRange(index, index);
      output.push(...normalizeCodeFenceSpacing(transformedSingleLineCode));
      continue;
    }

    if (isStandaloneCodeLine(line)) {
      const codeLines = [trimCodeLine(line)];
      const { codeLines: continuationLines, lastIndex } = collectCodeContinuationLines(
        lines,
        index + 1,
        countParenBalance(line)
      );
      codeLines.push(...continuationLines);
      recordSynthesizedCodeRange(index, lastIndex);

      output.push(
        ...normalizeCodeFenceSpacing([
          `\`\`\`${inferStandaloneCodeLanguage(codeLines)}`,
          ...codeLines,
          '```',
        ])
      );
      index = lastIndex;
      continue;
    }

    const parts = line.split(/(`[^`]+`)/);
    output.push(
      parts.map((part, i) => (i % 2 === 1 ? part : escapeDisallowedRawHtml(part))).join('')
    );
  }

  return { markdown: output.join('\n'), synthesizedCodeRanges };
};

export const processMarkdownSegment = (segment: string): string =>
  planMarkdownSegmentRendering(segment).markdown;
