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
  content
    .split('\n')
    .map(line => (shouldRemoveAccidentalIndentation(line) ? line.trimStart() : line))
    .join('\n');

export const getAccidentalPlainTextIndentationRanges = (
  content: string,
  protectedRanges: readonly SourceRange[] = []
): Array<{ end: number; start: number }> => {
  const ranges: Array<{ end: number; start: number }> = [];
  let lineStart = 0;
  for (const line of content.split('\n')) {
    if (
      !isProtectedLine(lineStart, line.length, protectedRanges) &&
      shouldRemoveAccidentalIndentation(line)
    ) {
      const indentationLength = line.length - line.trimStart().length;
      ranges.push({ start: lineStart, end: lineStart + indentationLength });
    }
    lineStart += line.length + 1;
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
  let lineStart = 0;
  for (const line of content.split('\n')) {
    const indentationLength =
      !isProtectedLine(lineStart, line.length, protectedRanges) &&
      shouldRemoveAccidentalIndentation(line)
        ? line.length - line.trimStart().length
        : 0;
    for (let index = indentationLength; index < line.length; index += 1) {
      characters.push(line[index]);
      sourceOffsets.push(lineStart + index);
    }
    if (lineStart + line.length < content.length) {
      characters.push('\n');
      sourceOffsets.push(lineStart + line.length);
    }
    lineStart += line.length + 1;
  }
  sourceOffsets.push(content.length);
  return { content: characters.join(''), sourceOffsets };
};
