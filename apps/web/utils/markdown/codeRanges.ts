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
  '{{VISUAL_SLOT:',
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
  let hasClosedAngleDestination = false;
  let hasDestination = false;
  let isAngleDestination = false;

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
    if (index === openingParenthesisIndex + 1 && character === '<') {
      isAngleDestination = true;
      continue;
    }
    if (isAngleDestination) {
      if (/\s/u.test(character)) {
        return -1;
      }
      if (character === '>') {
        isAngleDestination = false;
        hasClosedAngleDestination = true;
        hasDestination = true;
      }
      continue;
    }
    if (hasClosedAngleDestination && character !== ')' && !/\s/u.test(character)) {
      return -1;
    }
    if (depth === 1 && /\s/u.test(character)) {
      const nextNonWhitespaceIndex = value.slice(index).search(/\S/u) + index;
      const nextCharacter = value[nextNonWhitespaceIndex];
      if (
        !hasDestination ||
        (nextCharacter !== ')' &&
          nextCharacter !== '"' &&
          nextCharacter !== "'" &&
          nextCharacter !== '(')
      ) {
        return -1;
      }
      index = nextNonWhitespaceIndex - 1;
      continue;
    }
    if (depth === 1 && (character === '"' || character === "'") && /\s/u.test(value[index - 1])) {
      activeTitleQuote = character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      if (depth > 1) hasDestination = true;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
    if (depth === 1) hasDestination = true;
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

export const findInlineLabelEnd = (content: string, openingBracketIndex: number): number => {
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

const normalizeReferenceLabel = (label: string): string =>
  label.trim().replaceAll(/\s+/gu, ' ').toLowerCase();

const MARKDOWN_TAB_COLUMNS = 4;
const REFERENCE_DEFINITION_MIN_INDENT_COLUMNS = 0;
const REFERENCE_DEFINITION_MAX_INDENT_COLUMNS = 3;
const REFERENCE_CONTINUATION_MIN_INDENT_COLUMNS = 1;
const REFERENCE_CONTINUATION_MAX_INDENT_COLUMNS = 3;
const MARKDOWN_RAW_HTML_BLOCK_TAG_PATTERN =
  /^<(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>)/iu;
const MARKDOWN_COMPLETE_HTML_TAG_PATTERN =
  /^(?:<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>|<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ "'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>)[ \t]*$/u;
const MARKDOWN_MALFORMED_CLOSING_TAG_PATTERN = /^<\/[A-Za-z][^>]*>/u;

const readMarkdownIndent = (line: string): { columns: number; length: number } => {
  let columns = 0;
  let length = 0;
  while (length < line.length) {
    if (line[length] === ' ') {
      columns += 1;
      length += 1;
      continue;
    }
    if (line[length] === '\t') {
      columns += MARKDOWN_TAB_COLUMNS - (columns % MARKDOWN_TAB_COLUMNS);
      length += 1;
      continue;
    }
    break;
  }
  return { columns, length };
};

const getRawHtmlBlockEnd = (line: string): RegExp | 'blank-line' | null => {
  if (/^<!--/u.test(line)) return /-->/u;
  if (/^<\?/u.test(line)) return /\?>/u;
  if (/^<!\[CDATA\[/u.test(line)) return /\]\]>/u;
  if (/^<![A-Z]/u.test(line)) return />/u;
  const rawTag = line.match(/^<(script|pre|style|textarea)(?:\s|>)/iu)?.[1];
  if (rawTag) return new RegExp(`</${rawTag}\\s*>`, 'iu');
  return MARKDOWN_RAW_HTML_BLOCK_TAG_PATTERN.test(line) ||
    MARKDOWN_COMPLETE_HTML_TAG_PATTERN.test(line) ||
    MARKDOWN_MALFORMED_CLOSING_TAG_PATTERN.test(line)
    ? 'blank-line'
    : null;
};

export const getMarkdownReferenceDefinitionRanges = (content: string): MarkdownRange[] => {
  const ranges: MarkdownRange[] = [];
  const codeRanges = getMarkdownCodeRanges(content);
  const titlePattern = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))$/u;
  let lineStart = 0;
  let rawHtmlBlockEnd: RegExp | 'blank-line' | null = null;

  while (lineStart < content.length) {
    const lineBreak = content.indexOf('\n', lineStart);
    const lineEnd = lineBreak === -1 ? content.length : lineBreak;
    const indentation = readMarkdownIndent(content.slice(lineStart, lineEnd));
    const labelStart = lineStart + indentation.length;
    const markdownLine = content.slice(labelStart, lineEnd);
    if (rawHtmlBlockEnd) {
      const blockEnded =
        rawHtmlBlockEnd === 'blank-line'
          ? markdownLine.trim() === ''
          : rawHtmlBlockEnd.test(markdownLine);
      if (blockEnded) rawHtmlBlockEnd = null;
      lineStart = lineBreak === -1 ? content.length : lineBreak + 1;
      continue;
    }
    const lineOverlapsCode = codeRanges.some(
      range => range.start < lineEnd && range.end > lineStart
    );
    if (lineOverlapsCode) {
      lineStart = lineBreak === -1 ? content.length : lineBreak + 1;
      continue;
    }
    if (indentation.columns <= REFERENCE_DEFINITION_MAX_INDENT_COLUMNS) {
      rawHtmlBlockEnd = getRawHtmlBlockEnd(markdownLine);
      if (rawHtmlBlockEnd) {
        if (rawHtmlBlockEnd !== 'blank-line' && rawHtmlBlockEnd.test(markdownLine)) {
          rawHtmlBlockEnd = null;
        }
        lineStart = lineBreak === -1 ? content.length : lineBreak + 1;
        continue;
      }
    }
    const labelEnd =
      indentation.columns >= REFERENCE_DEFINITION_MIN_INDENT_COLUMNS &&
      indentation.columns <= REFERENCE_DEFINITION_MAX_INDENT_COLUMNS &&
      content[labelStart] === '['
        ? findInlineLabelEnd(content, labelStart)
        : -1;
    let cursor = labelEnd + 1;
    const normalizedLabel =
      labelEnd === -1 ? '' : normalizeReferenceLabel(content.slice(labelStart + 1, labelEnd));

    if (normalizedLabel && labelEnd !== -1 && labelEnd < lineEnd && content[cursor] === ':') {
      cursor += 1;
      while (cursor < lineEnd && /[ \t]/u.test(content[cursor])) cursor += 1;
      let destinationLineEnd = lineEnd;
      let destinationLineBreak = lineBreak;
      let definitionEnd = lineEnd;
      if (cursor === lineEnd && lineBreak !== -1) {
        const continuationLineBreak = content.indexOf('\n', lineBreak + 1);
        const continuationLineEnd =
          continuationLineBreak === -1 ? content.length : continuationLineBreak;
        const continuationIndent = readMarkdownIndent(
          content.slice(lineBreak + 1, continuationLineEnd)
        );
        if (
          continuationIndent.columns >= REFERENCE_CONTINUATION_MIN_INDENT_COLUMNS &&
          continuationIndent.columns <= REFERENCE_CONTINUATION_MAX_INDENT_COLUMNS
        ) {
          cursor = lineBreak + 1 + continuationIndent.length;
          destinationLineEnd = continuationLineEnd;
          destinationLineBreak = continuationLineBreak;
          definitionEnd = continuationLineEnd;
        }
      }
      const destinationStart = cursor;
      let parenthesisDepth = 0;

      if (content[cursor] === '<') {
        cursor += 1;
        while (
          cursor < destinationLineEnd &&
          content[cursor] !== '>' &&
          !/\s/u.test(content[cursor])
        ) {
          cursor += content[cursor] === '\\' ? 2 : 1;
        }
        cursor = content[cursor] === '>' ? cursor + 1 : destinationStart;
      } else {
        while (cursor < destinationLineEnd && !/[ \t]/u.test(content[cursor])) {
          if (content[cursor] === '\\') {
            cursor += 2;
            continue;
          }
          if (content[cursor] === '(') parenthesisDepth += 1;
          if (content[cursor] === ')') parenthesisDepth -= 1;
          if (parenthesisDepth < 0) break;
          cursor += 1;
        }
        if (parenthesisDepth !== 0) cursor = destinationStart;
      }

      const hasDestination = cursor > destinationStart;
      const trailingText = content.slice(cursor, destinationLineEnd).trim();
      if (hasDestination && !trailingText && destinationLineBreak !== -1) {
        const nextLineBreak = content.indexOf('\n', destinationLineBreak + 1);
        const continuationEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
        const continuation = content.slice(destinationLineBreak + 1, continuationEnd);
        const continuationIndent = readMarkdownIndent(continuation);
        if (
          continuationIndent.columns >= REFERENCE_CONTINUATION_MIN_INDENT_COLUMNS &&
          continuationIndent.columns <= REFERENCE_CONTINUATION_MAX_INDENT_COLUMNS &&
          titlePattern.test(continuation.trim())
        ) {
          definitionEnd = continuationEnd;
        }
      }

      if (
        hasDestination &&
        (!trailingText || titlePattern.test(trailingText)) &&
        !codeRanges.some(range => range.start < definitionEnd && range.end > lineStart)
      ) {
        ranges.push({ start: lineStart, end: definitionEnd });
        lineStart = definitionEnd + (content[definitionEnd] === '\n' ? 1 : 0);
        continue;
      }
    }

    lineStart = lineBreak === -1 ? content.length : lineBreak + 1;
  }
  return ranges;
};

const getMarkdownReferenceLabels = (content: string): Set<string> => {
  const labels = new Set<string>();
  for (const range of getMarkdownReferenceDefinitionRanges(content)) {
    const labelStart = content.indexOf('[', range.start);
    const labelEnd = findInlineLabelEnd(content, labelStart);
    if (labelEnd !== -1) {
      labels.add(normalizeReferenceLabel(content.slice(labelStart + 1, labelEnd)));
    }
  }
  return labels;
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

export const getMarkdownImageRanges = (content: string): MarkdownRange[] => {
  const ranges: MarkdownRange[] = [];
  const codeRanges = getMarkdownCodeRanges(content);
  const referenceLabels = getMarkdownReferenceLabels(content);
  let index = 0;

  while (index < content.length) {
    const imageStart = content.indexOf('![', index);
    if (imageStart === -1) {
      break;
    }

    if (codeRanges.some(range => range.start < imageStart + 2 && range.end > imageStart)) {
      index = imageStart + 2;
      continue;
    }

    if (isEscapedCharacter(content, imageStart)) {
      index = imageStart + 2;
      continue;
    }

    const labelEnd = findInlineLabelEnd(content, imageStart + 1);
    if (labelEnd === -1) {
      index = imageStart + 2;
      continue;
    }

    const destinationStart = labelEnd + 1;
    if (content[destinationStart] !== '(') {
      const altText = content.slice(imageStart + 2, labelEnd);
      if (content[destinationStart] === '[') {
        const referenceEnd = findInlineLabelEnd(content, destinationStart);
        const referenceLabel =
          referenceEnd === -1 ? '' : content.slice(destinationStart + 1, referenceEnd) || altText;
        if (referenceEnd !== -1 && referenceLabels.has(normalizeReferenceLabel(referenceLabel))) {
          ranges.push({ start: imageStart, end: referenceEnd + 1 });
          index = referenceEnd + 1;
          continue;
        }
      } else if (referenceLabels.has(normalizeReferenceLabel(altText))) {
        ranges.push({ start: imageStart, end: labelEnd + 1 });
        index = labelEnd + 1;
        continue;
      }

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

export const getMarkdownLinkDestinationRanges = (content: string): MarkdownRange[] => {
  const ranges: MarkdownRange[] = [];
  const codeRanges = getMarkdownCodeRanges(content);
  let index = 0;

  while (index < content.length) {
    const labelStart = content.indexOf('[', index);
    if (labelStart === -1) break;
    if (codeRanges.some(range => range.start < labelStart + 1 && range.end > labelStart)) {
      index = labelStart + 1;
      continue;
    }
    if (content[labelStart - 1] === '!' || isEscapedCharacter(content, labelStart)) {
      index = labelStart + 1;
      continue;
    }
    const labelEnd = findInlineLabelEnd(content, labelStart);
    const destinationStart = labelEnd + 1;
    if (labelEnd === -1 || content[destinationStart] !== '(') {
      index = labelStart + 1;
      continue;
    }
    const destinationEnd = findInlineLinkDestinationEnd(content, destinationStart);
    if (destinationEnd === -1) {
      index = labelStart + 1;
      continue;
    }
    ranges.push({ start: destinationStart, end: destinationEnd + 1 });
    index = destinationEnd + 1;
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
    ...getMarkdownLinkDestinationRanges(content),
    ...getMarkdownReferenceDefinitionRanges(content),
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
