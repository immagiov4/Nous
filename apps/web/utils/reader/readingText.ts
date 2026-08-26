import {
  getMarkdownProtectedRanges,
  isMarkdownPlaceholderLiteralInsideCode,
  type MarkdownRange,
  mergeOverlappingMarkdownRanges,
  parseMarkdownAnalysis,
  readCompleteMarkdownPlaceholderRange,
} from '../markdown/codeRanges.ts';
import {
  buildVisibleProjection,
  getHiddenInlineBoundaryRanges,
} from '../markdown/textProjection.ts';

const isInlineWhitespace = (character: string): boolean => character === ' ' || character === '\t';

const trimTrailingInlineSpace = (characters: string[]): void => {
  while (characters.at(-1) === ' ') {
    characters.pop();
  }
};

const appendInlineSpace = (characters: string[]): void => {
  if (characters.length > 0 && characters.at(-1) !== ' ') {
    characters.push(' ');
  }
};

const appendCollapsedNewline = (characters: string[], consecutiveNewlines: number): void => {
  trimTrailingInlineSpace(characters);
  if (consecutiveNewlines <= 2) {
    characters.push('\n');
  }
};

const collapseWhitespace = (text: string): string => {
  const characters: string[] = [];
  let consecutiveNewlines = 0;

  for (const character of text) {
    if (character === '\r') {
      continue;
    }

    if (isInlineWhitespace(character)) {
      appendInlineSpace(characters);
      continue;
    }

    if (character === '\n') {
      consecutiveNewlines += 1;
      appendCollapsedNewline(characters, consecutiveNewlines);
      continue;
    }

    consecutiveNewlines = 0;
    characters.push(character);
  }

  return characters.join('').trim();
};

const BLOCK_PAUSE_WEIGHT = 200;
export const READER_NON_SPEECH_SELECTOR =
  'figure, figcaption, img, picture, svg, canvas, [data-nous-speech="ignore"]';
const READABLE_TEXT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
const PROSE_READABLE_TEXT_SELECTOR = READABLE_TEXT_SELECTOR.split(', ')
  .map(selector => `.prose ${selector}`)
  .join(', ');
const HTML_SPACE_ENTITY = '&nbsp;';
const HTML_TAGS_TO_DROP_WITH_CONTENT = ['figure', 'picture', 'figcaption'] as const;
const HTML_TAGS_TO_STRIP = new Set(['mark']);

const rangeContainsLineBreak = (content: string, range: MarkdownRange): boolean =>
  content.slice(range.start, range.end).includes('\n');

const readInlineCode = (content: string, range: MarkdownRange): string | null => {
  const protectedText = content.slice(range.start, range.end);
  if (!protectedText.startsWith('`') || protectedText.includes('\n')) {
    return null;
  }

  const delimiter = protectedText.match(/^`+/u)?.[0] ?? '';
  if (
    !delimiter ||
    !protectedText.endsWith(delimiter) ||
    protectedText.length <= delimiter.length * 2
  ) {
    return null;
  }
  return protectedText.slice(delimiter.length, -delimiter.length).trim();
};

const replaceMarkdownProtectedRanges = (content: string): string => {
  const ranges = getMarkdownProtectedRanges(content);
  if (ranges.length === 0) {
    return content;
  }

  let nextContent = '';
  let cursor = 0;

  ranges.forEach(range => {
    nextContent += content.slice(cursor, range.start);
    const inlineCode = readInlineCode(content, range);
    nextContent += inlineCode ?? (rangeContainsLineBreak(content, range) ? '\n' : ' ');
    cursor = range.end;
  });

  nextContent += content.slice(cursor);
  return nextContent;
};

const stripCompletePlaceholdersOutsideProtectedMarkdown = (content: string): string => {
  const protectedRanges = getMarkdownProtectedRanges(content);
  let normalizedContent = '';
  let cursor = 0;
  let protectedRangeIndex = 0;

  while (cursor < content.length) {
    const protectedRange = protectedRanges[protectedRangeIndex];
    if (protectedRange?.start === cursor) {
      const protectedContent = content.slice(protectedRange.start, protectedRange.end);
      normalizedContent += rangeContainsLineBreak(content, protectedRange)
        ? protectedContent
        : stripCompletePlaceholders(protectedContent, true);
      cursor = protectedRange.end;
      protectedRangeIndex += 1;
      continue;
    }

    const unprotectedEnd = protectedRange?.start ?? content.length;
    normalizedContent += stripCompletePlaceholders(content.slice(cursor, unprotectedEnd), false);
    cursor = unprotectedEnd;
  }

  return normalizedContent;
};

const stripCompletePlaceholders = (content: string, preserveCodeLiterals: boolean): string => {
  let normalizedContent = '';
  let cursor = 0;

  while (cursor < content.length) {
    const placeholderRange = readCompleteMarkdownPlaceholderRange(content, cursor);
    if (
      placeholderRange &&
      !(
        preserveCodeLiterals &&
        isMarkdownPlaceholderLiteralInsideCode(content, placeholderRange.start)
      )
    ) {
      normalizedContent += ' ';
      cursor = placeholderRange.end;
      continue;
    }

    normalizedContent += content[cursor];
    cursor += 1;
  }

  return normalizedContent;
};

const stripHtmlTag = (content: string, tagName: string): string => {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let normalizedContent = '';
  let cursor = 0;

  while (cursor < content.length) {
    const tagIndex = content.toLowerCase().indexOf(openTag, cursor);
    if (tagIndex === -1) {
      normalizedContent += content.slice(cursor);
      break;
    }

    normalizedContent += content.slice(cursor, tagIndex);
    const openTagEnd = content.indexOf('>', tagIndex + openTag.length);
    if (openTagEnd === -1) {
      normalizedContent += content.slice(tagIndex);
      break;
    }

    const lowerCasedContent = content.toLowerCase();
    const closeTagIndex = lowerCasedContent.indexOf(closeTag, openTagEnd + 1);
    normalizedContent += ' ';
    cursor = closeTagIndex === -1 ? openTagEnd + 1 : closeTagIndex + closeTag.length;
  }

  return normalizedContent;
};

const stripHtmlVoidTag = (content: string, tagName: string): string => {
  const openTag = `<${tagName}`;
  let normalizedContent = '';
  let cursor = 0;

  while (cursor < content.length) {
    const tagIndex = content.toLowerCase().indexOf(openTag, cursor);
    if (tagIndex === -1) {
      normalizedContent += content.slice(cursor);
      break;
    }

    normalizedContent += content.slice(cursor, tagIndex);
    const tagEnd = content.indexOf('>', tagIndex + openTag.length);
    normalizedContent += ' ';
    cursor = tagEnd === -1 ? content.length : tagEnd + 1;
  }

  return normalizedContent;
};

const stripAllowedHtmlTags = (content: string): string => {
  let normalizedContent = '';
  let cursor = 0;

  while (cursor < content.length) {
    const tagStart = content.indexOf('<', cursor);
    if (tagStart === -1) {
      normalizedContent += content.slice(cursor);
      break;
    }

    normalizedContent += content.slice(cursor, tagStart);
    const tagEnd = content.indexOf('>', tagStart + 1);
    if (tagEnd === -1) {
      normalizedContent += content.slice(tagStart);
      break;
    }

    const rawTag = content.slice(tagStart + 1, tagEnd).trim();
    const normalizedTag = rawTag.startsWith('/') ? rawTag.slice(1).trim() : rawTag;
    const tagName = normalizedTag.split(/[\s/>]/u, 1)[0]?.toLowerCase();

    if (tagName && HTML_TAGS_TO_STRIP.has(tagName)) {
      cursor = tagEnd + 1;
      continue;
    }

    normalizedContent += content.slice(tagStart, tagEnd + 1);
    cursor = tagEnd + 1;
  }

  return normalizedContent;
};

const findClosingMarkdownParen = (content: string, startIndex: number): number => {
  let depth = 0;

  for (let index = startIndex; index < content.length; index += 1) {
    const character = content[index];
    if (character === '(') {
      depth += 1;
      continue;
    }

    if (character !== ')') {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  return -1;
};

interface MarkdownLinkCandidate {
  isImage: boolean;
  start: number;
}

const findNextMarkdownLinkCandidate = (
  content: string,
  cursor: number
): MarkdownLinkCandidate | null => {
  const imageStart = content.indexOf('![', cursor);
  const linkStart = content.indexOf('[', cursor);

  if (imageStart === -1 && linkStart === -1) {
    return null;
  }

  if (imageStart !== -1 && (linkStart === -1 || imageStart <= linkStart)) {
    return { isImage: true, start: imageStart };
  }

  return { isImage: false, start: linkStart };
};

const normalizeMarkdownLinks = (content: string): string => {
  let normalizedContent = '';
  let cursor = 0;

  while (cursor < content.length) {
    const candidate = findNextMarkdownLinkCandidate(content, cursor);
    if (!candidate) {
      normalizedContent += content.slice(cursor);
      break;
    }

    normalizedContent += content.slice(cursor, candidate.start);

    const labelStart = candidate.start + (candidate.isImage ? 2 : 1);
    const labelEnd = content.indexOf(']', labelStart);
    const urlStart = labelEnd === -1 ? -1 : labelEnd + 1;

    if (labelEnd === -1 || content[urlStart] !== '(') {
      normalizedContent += content[candidate.start];
      cursor = candidate.start + 1;
      continue;
    }

    const urlEnd = findClosingMarkdownParen(content, urlStart);
    if (urlEnd === -1) {
      normalizedContent += content[candidate.start];
      cursor = candidate.start + 1;
      continue;
    }

    if (candidate.isImage) {
      normalizedContent += ' ';
    } else {
      normalizedContent += content.slice(labelStart, labelEnd);
    }

    cursor = urlEnd + 1;
  }

  return normalizedContent;
};

const isMarkdownListMarker = (character: string | undefined): boolean =>
  character === '>' || character === '-' || character === '*' || character === '+';

const findMarkdownLinePrefixEnd = (line: string, prefixStart: number): number | null => {
  const prefixCharacter = line[prefixStart];
  if (!prefixCharacter) {
    return null;
  }

  let cursor = prefixStart;
  if (prefixCharacter === '#') {
    while (line[cursor] === '#') {
      cursor += 1;
    }
    return cursor;
  }

  if (isMarkdownListMarker(prefixCharacter)) {
    return cursor + 1;
  }

  while (line[cursor] >= '0' && line[cursor] <= '9') {
    cursor += 1;
  }

  return cursor > prefixStart && line[cursor] === '.' ? cursor + 1 : null;
};

const stripMarkdownLinePrefix = (line: string): string => {
  let cursor = 0;

  while (cursor < line.length && cursor < 3 && line[cursor] === ' ') {
    cursor += 1;
  }

  const prefixStart = cursor;
  const prefixEnd = findMarkdownLinePrefixEnd(line, prefixStart);
  if (prefixEnd === null) {
    return line;
  }

  cursor = prefixEnd;
  if (line[cursor] !== ' ') {
    return line;
  }

  while (cursor < line.length && line[cursor] === ' ') {
    cursor += 1;
  }

  return line.slice(cursor);
};

const stripMarkdownFormattingMarkers = (content: string): string => {
  let normalizedContent = '';

  for (const character of content) {
    normalizedContent +=
      character === '*' || character === '_' || character === '~' || character === '|'
        ? ' '
        : character;
  }

  return normalizedContent;
};

const getReadingWeight = (text: string): number => {
  const baseLength = text.length;
  const periods = (text.match(/[.!?]/g) || []).length;
  const commas = (text.match(/[,;:]/g) || []).length;
  return baseLength + periods * 60 + commas * 20;
};

export interface ReadableSegment {
  startAudio: number;
  endAudio: number;
  top: number;
  bottom: number;
}

export interface ReadableBlock extends ReadableSegment {
  text: string;
  hitTop: number;
  hitBottom: number;
}

export interface ReadableTextElement {
  element: HTMLElement;
  text: string;
}

export const prepareMarkdownForSpeech = (content: string): string => {
  const analysis = parseMarkdownAnalysis(content);
  const separatorRanges = getHiddenInlineBoundaryRanges(content, analysis);
  const { insertedBoundarySourceIndexes } = buildVisibleProjection(content, analysis);
  const rendererHiddenContentStripped = mergeOverlappingMarkdownRanges([
    ...separatorRanges,
    ...analysis.htmlSyntaxRanges,
    ...analysis.referenceLinkLabelRanges,
    ...analysis.referenceDefinitionRanges,
    ...analysis.rendererNormalizedIndentRanges,
    ...analysis.structuralRanges,
  ])
    .sort((left, right) => right.start - left.start)
    .reduce((currentContent, range) => {
      const replacesVisibleBoundary = separatorRanges.some(
        separatorRange => separatorRange.start < range.end && separatorRange.end > range.start
      );
      const separator =
        replacesVisibleBoundary &&
        insertedBoundarySourceIndexes.some(
          sourceIndex => sourceIndex >= range.start && sourceIndex <= range.end
        )
          ? ' '
          : '';
      return `${currentContent.slice(0, range.start)}${separator}${currentContent.slice(range.end)}`;
    }, content);
  const placeholderStrippedContent = stripCompletePlaceholdersOutsideProtectedMarkdown(
    rendererHiddenContentStripped
  );
  const markdownProtectedContent = replaceMarkdownProtectedRanges(placeholderStrippedContent);
  const htmlContentRemoved = HTML_TAGS_TO_DROP_WITH_CONTENT.reduce(
    (nextContent, tagName) => stripHtmlTag(nextContent, tagName),
    markdownProtectedContent
  );
  const htmlVoidTagsRemoved = stripHtmlVoidTag(htmlContentRemoved, 'img');
  const htmlTagsStripped = stripAllowedHtmlTags(htmlVoidTagsRemoved).replaceAll(
    HTML_SPACE_ENTITY,
    ' '
  );
  const markdownLinksNormalized = normalizeMarkdownLinks(htmlTagsStripped);
  const markdownPrefixesStripped = markdownLinksNormalized
    .split('\n')
    .map(stripMarkdownLinePrefix)
    .join('\n');

  return collapseWhitespace(stripMarkdownFormattingMarkers(markdownPrefixesStripped));
};

const extractReadableElementText = (element: HTMLElement): string => {
  const clone = element.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(`pre, .katex, .katex-display, script, style, ${READER_NON_SPEECH_SELECTOR}`)
    .forEach(node => {
      node.remove();
    });

  return collapseWhitespace(clone.innerText || clone.textContent || '');
};

export const buildReadableTextElements = (container: HTMLElement): ReadableTextElement[] => {
  const proseTextElements = container.querySelectorAll(PROSE_READABLE_TEXT_SELECTOR);
  const textElements =
    proseTextElements.length > 0
      ? proseTextElements
      : container.querySelectorAll(READABLE_TEXT_SELECTOR);

  return Array.from(textElements)
    .filter(node => !(node as HTMLElement).closest(READER_NON_SPEECH_SELECTOR))
    .map(node => {
      const element = node as HTMLElement;
      return { element, text: extractReadableElementText(element) };
    })
    .filter(item => item.text.length > 0);
};

export const buildReadableBlocks = (container: HTMLElement): ReadableBlock[] => {
  const containerRect = container.getBoundingClientRect();
  let totalWeight = 0;
  const weightedElements = buildReadableTextElements(container)
    .map(({ element, text }) => {
      const weight = getReadingWeight(text);
      totalWeight += weight > 0 ? weight + BLOCK_PAUSE_WEIGHT : 0;
      return { element, text, weight };
    })
    .filter(item => item.weight > 0);

  if (totalWeight === 0) {
    return [];
  }

  const blocks: Array<Omit<ReadableBlock, 'hitTop' | 'hitBottom'>> = [];
  let weightSoFar = 0;

  weightedElements.forEach(({ element, text, weight }) => {
    const startPct = weightSoFar / totalWeight;
    const endPct = (weightSoFar + weight) / totalWeight;
    const elementRect = element.getBoundingClientRect();
    const elementTop = elementRect.top - containerRect.top;

    blocks.push({
      startAudio: startPct,
      endAudio: endPct,
      top: elementTop,
      bottom: elementTop + elementRect.height,
      text,
    });

    weightSoFar += weight + BLOCK_PAUSE_WEIGHT;
  });

  return blocks.map((block, index) => {
    const previousBlock = blocks[index - 1];
    const nextBlock = blocks[index + 1];

    return {
      ...block,
      hitTop: previousBlock ? (previousBlock.bottom + block.top) / 2 : block.top,
      hitBottom: nextBlock ? (block.bottom + nextBlock.top) / 2 : block.bottom,
    };
  });
};

const _buildReadableSegments = (container: HTMLElement): ReadableSegment[] =>
  buildReadableBlocks(container).map(({ startAudio, endAudio, top, bottom }) => ({
    startAudio,
    endAudio,
    top,
    bottom,
  }));
