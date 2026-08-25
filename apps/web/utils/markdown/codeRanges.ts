export interface MarkdownRange {
  start: number;
  end: number;
}

const MARK_TAG_REGEX = /<\/?mark\b[^>]*>/g;
const TEXT_LIKE_MATH_COMMANDS = new Set(['text', 'mathrm', 'mathtt', 'operatorname']);
const ZERO_WIDTH_CHARACTERS_REGEX = /[\u200b-\u200d\uFEFF]/gu;
export const NON_ANCHORABLE_MARKDOWN_PLACEHOLDER_PREFIXES = [
  '{{PDF_IMAGE:',
  '{{VISUAL_EXAMPLE:',
  '{{YOUTUBE_CLIP_SOURCE:',
  '{{INLINE_QUIZ:',
] as const;

const isLineStart = (content: string, index: number) => index === 0 || content[index - 1] === '\n';
const isAsciiAlphaNumeric = (character: string | undefined): boolean =>
  Boolean(character && /[A-Za-z0-9]/u.test(character));

export const findInlineLinkDestinationEnd = (
  value: string,
  openingParenthesisIndex: number
): number => {
  if (value[openingParenthesisIndex] !== '(') {
    return -1;
  }

  let depth = 0;
  let activeTitleQuote: '"' | "'" | null = null;

  for (let index = openingParenthesisIndex; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (activeTitleQuote) {
      if (character === activeTitleQuote) activeTitleQuote = null;
      continue;
    }
    if (depth === 1 && (character === '"' || character === "'") && /\s/u.test(value[index - 1])) {
      activeTitleQuote = character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
};

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

const isEscapedCharacter = (content: string, index: number) => {
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
): MarkdownRange | null => {
  let cursor = startIndex + openDelimiter.length;

  while (cursor < content.length) {
    if (!allowNewlines && content[cursor] === '\n') {
      return null;
    }

    if (content.startsWith(closeDelimiter, cursor) && !isEscapedCharacter(content, cursor)) {
      return {
        start: startIndex,
        end: cursor + closeDelimiter.length,
      };
    }

    cursor += 1;
  }

  return null;
};

export const getMarkdownMathRangeAt = (
  content: string,
  startIndex: number
): MarkdownRange | null => {
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

const getMarkdownMathInnerRange = (content: string, range: MarkdownRange): MarkdownRange => {
  if (content.startsWith('$$', range.start)) {
    return { start: range.start + 2, end: Math.max(range.start + 2, range.end - 2) };
  }

  if (content[range.start] === '$') {
    return { start: range.start + 1, end: Math.max(range.start + 1, range.end - 1) };
  }

  return { start: range.start + 2, end: Math.max(range.start + 2, range.end - 2) };
};

export const projectMarkdownMathRange = (
  content: string,
  range: MarkdownRange
): { text: string; sourceIndexes: number[] } => {
  const innerRange = getMarkdownMathInnerRange(content, range);
  const characters: string[] = [];
  const sourceIndexes: number[] = [];

  const pushCharacter = (character: string, sourceIndex: number) => {
    characters.push(character);
    sourceIndexes.push(sourceIndex);
  };

  const pushCommandText = (command: string, sourceIndex: number) => {
    for (let index = 0; index < command.length; index += 1) {
      pushCharacter(command[index], Math.min(sourceIndex + index, innerRange.end - 1));
    }
  };

  let index = innerRange.start;

  while (index < innerRange.end) {
    if (content[index] === '\\') {
      const commandMatch = content.slice(index + 1, innerRange.end).match(/^[A-Za-z]+/u);

      if (commandMatch) {
        const command = commandMatch[0];
        const commandStart = index + 1;
        index = commandStart + command.length;

        if (!TEXT_LIKE_MATH_COMMANDS.has(command)) {
          pushCommandText(command, commandStart);
        }
        continue;
      }

      if (index + 1 < innerRange.end) {
        pushCharacter(content[index + 1], index + 1);
        index += 2;
        continue;
      }
    }

    const currentCharacter = content[index];
    if (
      currentCharacter === '{' ||
      currentCharacter === '}' ||
      currentCharacter === '_' ||
      currentCharacter === '^'
    ) {
      index += 1;
      continue;
    }

    pushCharacter(currentCharacter, index);
    index += 1;
  }

  return {
    text: characters.join(''),
    sourceIndexes,
  };
};

export const projectKatexAnnotationSource = (texSource: string): string => {
  const wrappedExpression = `$${texSource}$`;
  return projectMarkdownMathRange(wrappedExpression, {
    start: 0,
    end: wrappedExpression.length,
  }).text;
};

const projectInlineMathLikeExpression = (expression: string): string => {
  const projected = projectMarkdownMathRange(`$${expression}$`, {
    start: 0,
    end: expression.length + 2,
  }).text;

  return projected || expression;
};

const findClosingBraceIndex = (value: string, openingBraceIndex: number): number => {
  let braceDepth = 0;

  for (let index = openingBraceIndex; index < value.length; index += 1) {
    if (value[index] === '{') {
      braceDepth += 1;
      continue;
    }

    if (value[index] !== '}') {
      continue;
    }

    braceDepth -= 1;
    if (braceDepth === 0) {
      return index;
    }
  }

  return -1;
};

const findInlineMathLikeExpressionEnd = (value: string, startIndex: number): number | null => {
  let cursor = startIndex;

  while (isAsciiAlphaNumeric(value[cursor])) {
    cursor += 1;
  }

  if (cursor === startIndex) {
    return null;
  }

  let scriptCount = 0;

  while ((value[cursor] === '_' || value[cursor] === '^') && value[cursor + 1] === '{') {
    const closingBraceIndex = findClosingBraceIndex(value, cursor + 1);
    if (closingBraceIndex === -1 || closingBraceIndex === cursor + 2) {
      return scriptCount > 0 ? cursor : null;
    }

    scriptCount += 1;
    cursor = closingBraceIndex + 1;
  }

  return scriptCount > 0 ? cursor : null;
};

const collapseAdjacentDuplicatedWordRuns = (value: string): string => {
  let nextValue = value;

  while (true) {
    const collapsedValue = nextValue.replaceAll(/([A-Za-z][A-Za-z0-9]{2,})(?:\1){1,}/gu, '$1');

    if (collapsedValue === nextValue) {
      return collapsedValue;
    }

    nextValue = collapsedValue;
  }
};

export const normalizeMathSelectionArtifacts = (value: string): string => {
  const strippedValue = value.replaceAll(ZERO_WIDTH_CHARACTERS_REGEX, '');
  let projectedValue = '';
  let cursor = 0;

  while (cursor < strippedValue.length) {
    const expressionEnd = findInlineMathLikeExpressionEnd(strippedValue, cursor);
    if (expressionEnd === null) {
      projectedValue += strippedValue[cursor];
      cursor += 1;
      continue;
    }

    projectedValue += projectInlineMathLikeExpression(strippedValue.slice(cursor, expressionEnd));
    cursor = expressionEnd;
  }

  if (projectedValue === strippedValue) {
    return strippedValue;
  }

  return collapseAdjacentDuplicatedWordRuns(projectedValue);
};

const mergeRanges = (ranges: MarkdownRange[]): MarkdownRange[] => {
  if (ranges.length <= 1) {
    return ranges;
  }

  const sortedRanges = [...ranges].sort((left, right) => left.start - right.start);
  const mergedRanges: MarkdownRange[] = [sortedRanges[0]];

  for (let index = 1; index < sortedRanges.length; index += 1) {
    const currentRange = sortedRanges[index];
    const lastMergedRange = mergedRanges.at(-1) as MarkdownRange;

    if (currentRange.start <= lastMergedRange.end) {
      lastMergedRange.end = Math.max(lastMergedRange.end, currentRange.end);
      continue;
    }

    mergedRanges.push({ ...currentRange });
  }

  return mergedRanges;
};

const mergeOverlappingRanges = (ranges: MarkdownRange[]): MarkdownRange[] => {
  const mergedRanges: MarkdownRange[] = [];

  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const previousRange = mergedRanges.at(-1);
    if (previousRange && range.start < previousRange.end) {
      previousRange.end = Math.max(previousRange.end, range.end);
    } else {
      mergedRanges.push({ ...range });
    }
  }

  return mergedRanges;
};

const findInlineLabelEnd = (content: string, openingBracketIndex: number): number => {
  let depth = 0;
  for (let index = openingBracketIndex; index < content.length; index += 1) {
    if (content[index] === '\\') {
      index += 1;
      continue;
    }
    if (content[index] === '[') depth += 1;
    if (content[index] === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const getMarkdownCodeRanges = (content: string): MarkdownRange[] => {
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

const getMarkdownMathRanges = (content: string): MarkdownRange[] => {
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
      index = range.end;
      continue;
    }

    if (currentCharacter === '`') {
      const range = findInlineCodeRange(content, index);
      index = range.end;
      continue;
    }

    const mathRange = getMarkdownMathRangeAt(content, index);
    if (mathRange) {
      ranges.push(mathRange);
      index = mathRange.end;
      continue;
    }

    index += 1;
  }

  return mergeRanges(ranges);
};

const getMarkdownImageRanges = (content: string): MarkdownRange[] => {
  const ranges: MarkdownRange[] = [];
  let index = 0;

  while (index < content.length) {
    const imageStart = content.indexOf('![', index);
    if (imageStart === -1) {
      break;
    }

    if (isEscapedCharacter(content, imageStart)) {
      index = imageStart + 2;
      continue;
    }

    const labelEnd = findInlineLabelEnd(content, imageStart + 1);
    const destinationStart = labelEnd + 1;
    if (labelEnd === -1 || content[destinationStart] !== '(') {
      index = imageStart + 2;
      continue;
    }

    const imageEnd = findInlineLinkDestinationEnd(content, destinationStart);
    if (imageEnd === -1) {
      index = imageStart + 2;
      continue;
    }

    ranges.push({ start: imageStart, end: imageEnd + 1 });
    index = imageEnd + 1;
  }

  return ranges;
};

const getNonAnchorablePlaceholderRanges = (content: string): MarkdownRange[] => {
  const ranges: MarkdownRange[] = [];

  NON_ANCHORABLE_MARKDOWN_PLACEHOLDER_PREFIXES.forEach(prefix => {
    let index = content.indexOf(prefix);
    while (index !== -1) {
      const placeholderEnd = content.indexOf('}}', index + prefix.length);
      ranges.push({
        start: index,
        end: placeholderEnd === -1 ? content.length : placeholderEnd + 2,
      });
      index = placeholderEnd === -1 ? -1 : content.indexOf(prefix, placeholderEnd + 2);
    }
  });

  return ranges;
};

export const getMarkdownProtectedRanges = (content: string): MarkdownRange[] =>
  mergeRanges([...getMarkdownCodeRanges(content), ...getMarkdownMathRanges(content)]);

export const getMarkdownAnnotationProtectedRanges = (content: string): MarkdownRange[] =>
  mergeOverlappingRanges([
    ...getMarkdownCodeRanges(content),
    ...getMarkdownImageRanges(content),
    ...getMarkdownMathRanges(content),
    ...getNonAnchorablePlaceholderRanges(content),
  ]);

export const stripHighlightTagsInsideMarkdownCode = (content: string): string => {
  const ranges = getMarkdownCodeRanges(content);
  if (ranges.length === 0) {
    return content;
  }

  let cursor = 0;
  let updatedContent = '';

  ranges.forEach(range => {
    updatedContent += content.slice(cursor, range.start);
    updatedContent += content.slice(range.start, range.end).replaceAll(MARK_TAG_REGEX, '');
    cursor = range.end;
  });

  updatedContent += content.slice(cursor);
  return updatedContent;
};
