export interface MarkdownRange {
  start: number;
  end: number;
}

const MARK_TAG_REGEX = /<\/?mark>/g;

const isLineStart = (content: string, index: number) => index === 0 || content[index - 1] === '\n';

const countRepeatedCharacter = (content: string, index: number, character: string): number => {
  let cursor = index;

  while (content[cursor] === character) {
    cursor += 1;
  }

  return cursor - index;
};

const findFenceRange = (
  content: string,
  startIndex: number,
  fenceCharacter: '`' | '~'
): MarkdownRange => {
  const fenceLength = countRepeatedCharacter(content, startIndex, fenceCharacter);
  const openingLineEnd = content.indexOf('\n', startIndex);

  if (openingLineEnd === -1) {
    return { start: startIndex, end: content.length };
  }

  let cursor = openingLineEnd + 1;

  while (cursor < content.length) {
    if (isLineStart(content, cursor) && content[cursor] === fenceCharacter) {
      const closingFenceLength = countRepeatedCharacter(content, cursor, fenceCharacter);
      if (closingFenceLength >= fenceLength) {
        let closingLineEnd = cursor + closingFenceLength;
        while (closingLineEnd < content.length && content[closingLineEnd] !== '\n') {
          closingLineEnd += 1;
        }

        return {
          start: startIndex,
          end: closingLineEnd < content.length ? closingLineEnd + 1 : closingLineEnd,
        };
      }
    }

    const nextNewline = content.indexOf('\n', cursor);
    if (nextNewline === -1) {
      break;
    }
    cursor = nextNewline + 1;
  }

  return { start: startIndex, end: content.length };
};

const findInlineCodeRange = (content: string, startIndex: number): MarkdownRange => {
  const delimiterLength = countRepeatedCharacter(content, startIndex, '`');
  const delimiter = '`'.repeat(delimiterLength);
  const closingIndex = content.indexOf(delimiter, startIndex + delimiterLength);

  return {
    start: startIndex,
    end: closingIndex === -1 ? content.length : closingIndex + delimiterLength,
  };
};

const mergeRanges = (ranges: MarkdownRange[]): MarkdownRange[] => {
  if (ranges.length <= 1) {
    return ranges;
  }

  const sortedRanges = [...ranges].sort((left, right) => left.start - right.start);
  const mergedRanges: MarkdownRange[] = [sortedRanges[0]];

  for (let index = 1; index < sortedRanges.length; index += 1) {
    const currentRange = sortedRanges[index];
    const lastMergedRange = mergedRanges[mergedRanges.length - 1];

    if (currentRange.start <= lastMergedRange.end) {
      lastMergedRange.end = Math.max(lastMergedRange.end, currentRange.end);
      continue;
    }

    mergedRanges.push({ ...currentRange });
  }

  return mergedRanges;
};

export const getMarkdownCodeRanges = (content: string): MarkdownRange[] => {
  const ranges: MarkdownRange[] = [];
  let index = 0;

  while (index < content.length) {
    const currentCharacter = content[index];

    if (
      (currentCharacter === '`' || currentCharacter === '~') &&
      isLineStart(content, index) &&
      countRepeatedCharacter(content, index, currentCharacter) >= 3
    ) {
      const range = findFenceRange(content, index, currentCharacter);
      ranges.push(range);
      index = range.end;
      continue;
    }

    if (currentCharacter === '`') {
      const range = findInlineCodeRange(content, index);
      ranges.push(range);
      index = range.end;
      continue;
    }

    index += 1;
  }

  return mergeRanges(ranges);
};

export const stripHighlightTagsInsideMarkdownCode = (content: string): string => {
  const ranges = getMarkdownCodeRanges(content);
  if (ranges.length === 0) {
    return content;
  }

  let cursor = 0;
  let updatedContent = '';

  ranges.forEach(range => {
    updatedContent += content.slice(cursor, range.start);
    updatedContent += content.slice(range.start, range.end).replace(MARK_TAG_REGEX, '');
    cursor = range.end;
  });

  updatedContent += content.slice(cursor);
  return updatedContent;
};
