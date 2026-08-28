import {
  isCodeContinuationLine,
  isOrphanedCodeContinuationLine,
  isStandaloneCodeLine,
} from './codeHeuristics.ts';

const INDENTED_CODE_BLOCK_PREFIX_REGEX = /^(?: {4,}|\t+)/u;

interface SourceRange {
  end: number;
  start: number;
}

interface SourceLine {
  content: string;
  lineBreak: string;
  start: number;
}

const getSourceLines = (content: string): SourceLine[] => {
  const lines: SourceLine[] = [];
  let lineStart = 0;
  let cursor = 0;

  while (cursor < content.length) {
    const character = content[cursor];
    if (character !== '\r' && character !== '\n') {
      cursor += 1;
      continue;
    }

    const lineEnd = cursor;
    const hasCarriageReturnPair = character === '\r' && content[cursor + 1] === '\n';
    const lineBreakEnd = cursor + (hasCarriageReturnPair ? 2 : 1);
    lines.push({
      content: content.slice(lineStart, lineEnd),
      lineBreak: content.slice(lineEnd, lineBreakEnd),
      start: lineStart,
    });
    lineStart = lineBreakEnd;
    cursor = lineBreakEnd;
  }
  lines.push({ content: content.slice(lineStart), lineBreak: '', start: lineStart });

  return lines;
};

const isProtectedLine = (
  lineStart: number,
  lineLength: number,
  protectedRanges: readonly SourceRange[]
): boolean => {
  const lineEnd = lineStart + lineLength;
  return protectedRanges.some(range => range.start < lineEnd && lineStart < range.end);
};

const shouldRemoveAccidentalIndentation = (line: string): boolean => {
  if (!INDENTED_CODE_BLOCK_PREFIX_REGEX.test(line)) return false;
  const unindentedLine = line.trimStart();
  const isOrphanedArgumentLine =
    /[,)]/u.test(unindentedLine) && isOrphanedCodeContinuationLine(unindentedLine);
  return !(
    isStandaloneCodeLine(unindentedLine) ||
    isCodeContinuationLine(unindentedLine) ||
    isOrphanedArgumentLine
  );
};

export const removeAccidentalPlainTextIndentation = (content: string): string =>
  getSourceLines(content)
    .map(line => {
      const normalizedContent = shouldRemoveAccidentalIndentation(line.content)
        ? line.content.trimStart()
        : line.content;
      return normalizedContent + line.lineBreak;
    })
    .join('');

export const getAccidentalPlainTextIndentationRanges = (
  content: string,
  protectedRanges: readonly SourceRange[] = []
): Array<{ end: number; start: number }> => {
  const ranges: Array<{ end: number; start: number }> = [];
  for (const line of getSourceLines(content)) {
    if (
      !isProtectedLine(line.start, line.content.length, protectedRanges) &&
      shouldRemoveAccidentalIndentation(line.content)
    ) {
      const indentationLength = line.content.length - line.content.trimStart().length;
      ranges.push({ start: line.start, end: line.start + indentationLength });
    }
  }
  return ranges;
};

export interface MarkdownIndentationProjection {
  content: string;
  sourceOffsets: number[];
}

export const projectAccidentalPlainTextIndentation = (
  content: string,
  protectedRanges: readonly SourceRange[] = []
): MarkdownIndentationProjection => {
  const characters: string[] = [];
  const sourceOffsets: number[] = [];
  for (const line of getSourceLines(content)) {
    const indentationLength =
      !isProtectedLine(line.start, line.content.length, protectedRanges) &&
      shouldRemoveAccidentalIndentation(line.content)
        ? line.content.length - line.content.trimStart().length
        : 0;
    for (let index = indentationLength; index < line.content.length; index += 1) {
      characters.push(line.content[index]);
      sourceOffsets.push(line.start + index);
    }
    const lineBreakStart = line.start + line.content.length;
    for (let index = 0; index < line.lineBreak.length; index += 1) {
      characters.push(line.lineBreak[index]);
      sourceOffsets.push(lineBreakStart + index);
    }
  }
  sourceOffsets.push(content.length);
  return { content: characters.join(''), sourceOffsets };
};
