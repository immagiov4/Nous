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

export const processMarkdownSegment = (segment: string): string => {
  const lines = normalizeMathMarkdownSegment(removeAccidentalPlainTextIndentation(segment))
    .replaceAll(/\r/g, '')
    .split('\n');
  const output: string[] = [];

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

  return output.join('\n');
};
