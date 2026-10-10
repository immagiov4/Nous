export interface MarkdownMathRange {
  end: number;
  start: number;
}

const isEscapedCharacter = (content: string, index: number): boolean => {
  let slashCount = 0;
  let cursor = index - 1;

  while (cursor >= 0 && content[cursor] === '\\') {
    slashCount += 1;
    cursor -= 1;
  }

  return slashCount % 2 === 1;
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
    if (content.startsWith(closeDelimiter, cursor) && !isEscapedCharacter(content, cursor)) {
      return { start: startIndex, end: cursor + closeDelimiter.length };
    }
    cursor += 1;
  }

  return null;
};

export const getMarkdownMathRangeAt = (
  content: string,
  startIndex: number
): MarkdownMathRange | null => {
  if (content[startIndex] === '$' && !isEscapedCharacter(content, startIndex)) {
    if (content[startIndex + 1] === '$') {
      return findDelimitedMathRange(content, startIndex, '$$', '$$', true);
    }
    return findDelimitedMathRange(content, startIndex, '$', '$', false);
  }

  if (content.startsWith(String.raw`\(`, startIndex) && !isEscapedCharacter(content, startIndex)) {
    return findDelimitedMathRange(
      content,
      startIndex,
      String.raw`\(` as '\\(',
      String.raw`\)` as '\\)',
      false
    );
  }

  if (content.startsWith(String.raw`\[`, startIndex) && !isEscapedCharacter(content, startIndex)) {
    return findDelimitedMathRange(
      content,
      startIndex,
      String.raw`\[` as '\\[',
      String.raw`\]` as '\\]',
      true
    );
  }

  return null;
};
