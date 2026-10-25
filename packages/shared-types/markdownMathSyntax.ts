export interface MarkdownMathRange {
  end: number;
  start: number;
}

export const isEscapedMarkdownCharacter = (content: string, index: number): boolean => {
  let slashCount = 0;
  let cursor = index - 1;

  while (cursor >= 0 && content[cursor] === '\\') {
    slashCount += 1;
    cursor -= 1;
  }

  return slashCount % 2 === 1;
};

export const getMarkdownMathDelimitersAt = (content: string, start: number) => {
  if (isEscapedMarkdownCharacter(content, start)) return undefined;
  for (const [open, close, display] of [
    ['$$', '$$', true],
    ['$', '$', false],
    [String.raw`\(` as '\\(', String.raw`\)` as '\\)', false],
    [String.raw`\[` as '\\[', String.raw`\]` as '\\]', true],
  ] as const) {
    if (content.startsWith(open, start)) return { open, close, display };
  }
  return undefined;
};

const startsBlankLine = (content: string, index: number): boolean => {
  if (content[index] !== '\n' && content[index] !== '\r') return false;
  const nextLine = index + (content.startsWith('\r\n', index) ? 2 : 1);
  return /^[\t ]*[\r\n]/u.test(content.slice(nextLine));
};

const findDelimitedMathRange = (
  content: string,
  startIndex: number,
  openDelimiter: '$' | '$$' | '\\(' | '\\[',
  closeDelimiter: '$' | '$$' | '\\)' | '\\]',
  allowNewlines: boolean
): MarkdownMathRange | null => {
  let cursor = startIndex + openDelimiter.length;

  while (cursor < content.length) {
    if (!allowNewlines && content[cursor] === '\n') return null;
    if (startsBlankLine(content, cursor)) return null;
    if (
      content.startsWith(closeDelimiter, cursor) &&
      !isEscapedMarkdownCharacter(content, cursor)
    ) {
      if (
        openDelimiter === '$' &&
        (/\s/u.test(content[cursor - 1]) || /\d/u.test(content[cursor + 1] ?? ''))
      )
        return null;
      return { start: startIndex, end: cursor + closeDelimiter.length };
    }
    cursor += 1;
  }

  return null;
};

/** Pandoc tex_math_dollars, plus explicit TeX delimiters; offsets refer to the untouched source. */
export const getMarkdownMathRangeAt = (
  content: string,
  startIndex: number,
  { allowInlineNewlines = true }: { allowInlineNewlines?: boolean } = {}
): MarkdownMathRange | null => {
  const delimiters = getMarkdownMathDelimitersAt(content, startIndex);
  if (!delimiters) return null;
  if (delimiters.open === '$' && (!content[startIndex + 1] || /\s/u.test(content[startIndex + 1])))
    return null;
  return findDelimitedMathRange(
    content,
    startIndex,
    delimiters.open,
    delimiters.close,
    delimiters.display || allowInlineNewlines
  );
};
