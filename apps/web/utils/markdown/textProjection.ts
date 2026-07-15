import {
  getMarkdownMathRangeAt,
  type MarkdownRange,
  projectMarkdownMathRange,
} from './codeRanges.ts';

/**
 * Shared text-projection helpers used by highlight-selection and
 * section-annotation modules. Both build a "visible projection" from
 * Markdown content — stripping syntax, math, links, and images — then
 * use fuzzy matching to locate user-selected text spans in the source.
 */

export interface VisibleProjection {
  sourceIndexes: number[];
  text: string;
}

export interface TextMatch {
  index: number;
  text: string;
}

export interface LooseProjection {
  sourceIndexes: number[];
  text: string;
}

const PARAGRAPH_BREAK_REGEX = /\n(?:[ \t]*\n)+/gu;
const MARKDOWN_TOKENS = ['***', '___', '**', '__', '~~', '`', '*', '_', '$'];
const INLINE_FORMAT_DELIMITERS = ['***', '___', '**', '__', '~~', '*', '_'];

export const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

export const buildContextRegex = (value: string) =>
  escapeRegex(normalizeWhitespace(value)).replace(/\s+/g, '\\s+');

const normalizeLooseCharacter = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .toLowerCase();

export const normalizeLooseText = (value: string): string =>
  normalizeLooseCharacter(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const buildVisibleProjection = (content: string): VisibleProjection => {
  const characters: string[] = [];
  const sourceIndexes: number[] = [];
  let index = 0;
  let atLineStart = true;
  let activeCodeDelimiter: string | null = null;

  const pushCharacter = (character: string, sourceIndex: number) => {
    characters.push(character);
    sourceIndexes.push(sourceIndex);
  };

  while (index < content.length) {
    if (
      content.startsWith('{{PDF_IMAGE:', index) ||
      content.startsWith('{{VISUAL_EXAMPLE:', index)
    ) {
      const placeholderEnd = content.indexOf('}}', index);
      index = placeholderEnd === -1 ? content.length : placeholderEnd + 2;
      continue;
    }

    if (atLineStart) {
      const blockMarkerMatch = content.slice(index).match(/^\s{0,3}(?:#{1,6}|>|-|\*|\+|\d+\.)\s+/u);

      if (blockMarkerMatch) {
        index += blockMarkerMatch[0].length;
        atLineStart = false;
        continue;
      }
    }

    const currentCharacter = content[index];

    const mathRange = getMarkdownMathRangeAt(content, index);
    if (mathRange) {
      const mathProjection = projectMarkdownMathRange(content, mathRange);
      mathProjection.text.split('').forEach((character, projectionIndex) => {
        pushCharacter(character, mathProjection.sourceIndexes[projectionIndex] ?? mathRange.start);
      });
      atLineStart = false;
      index = mathRange.end;
      continue;
    }

    if (currentCharacter === '\r') {
      index += 1;
      continue;
    }

    if (currentCharacter === '\n') {
      pushCharacter('\n', index);
      atLineStart = true;
      index += 1;
      continue;
    }

    if (activeCodeDelimiter) {
      if (content.startsWith(activeCodeDelimiter, index)) {
        index += activeCodeDelimiter.length;
        activeCodeDelimiter = null;
        continue;
      }

      pushCharacter(currentCharacter, index);
      atLineStart = false;
      index += 1;
      continue;
    }

    if (currentCharacter === '`') {
      const delimiterLength = content.slice(index).match(/^`+/u)?.[0].length ?? 1;
      activeCodeDelimiter = '`'.repeat(delimiterLength);
      index += delimiterLength;
      continue;
    }

    if (currentCharacter === '<') {
      const tagEnd = content.indexOf('>', index);
      if (tagEnd !== -1) {
        index = tagEnd + 1;
        continue;
      }
    }

    if (currentCharacter === '!' && content[index + 1] === '[') {
      const imageEnd = content.indexOf(')', index + 2);
      if (imageEnd !== -1) {
        index = imageEnd + 1;
        continue;
      }
    }

    if (currentCharacter === '[' || currentCharacter === ']') {
      if (currentCharacter === ']' && content[index + 1] === '(') {
        const linkEnd = content.indexOf(')', index + 2);
        if (linkEnd !== -1) {
          index = linkEnd + 1;
          continue;
        }
      }

      index += 1;
      continue;
    }

    if (currentCharacter === '\\' && index + 1 < content.length) {
      pushCharacter(content[index + 1], index + 1);
      atLineStart = false;
      index += 2;
      continue;
    }

    const markdownToken = MARKDOWN_TOKENS.find(token => content.startsWith(token, index));
    if (markdownToken) {
      index += markdownToken.length;
      continue;
    }

    pushCharacter(currentCharacter, index);
    atLineStart = false;
    index += 1;
  }

  return {
    text: characters.join(''),
    sourceIndexes,
  };
};

export const buildLooseProjection = (content: string): LooseProjection => {
  const visibleProjection = buildVisibleProjection(content);
  const characters: string[] = [];
  const sourceIndexes: number[] = [];

  visibleProjection.text.split('').forEach((character, index) => {
    const normalizedCharacter = normalizeLooseCharacter(character);
    if (/^[\p{L}\p{N}]$/u.test(normalizedCharacter)) {
      characters.push(normalizedCharacter);
      sourceIndexes.push(visibleProjection.sourceIndexes[index]);
      return;
    }

    if (/\s/u.test(character)) {
      if (characters[characters.length - 1] !== ' ') {
        characters.push(' ');
        sourceIndexes.push(visibleProjection.sourceIndexes[index]);
      }
      return;
    }

    if (characters[characters.length - 1] !== ' ') {
      characters.push(' ');
      sourceIndexes.push(visibleProjection.sourceIndexes[index]);
    }
  });

  return {
    text: characters.join('').trim(),
    sourceIndexes,
  };
};

export const buildSourceLooseProjection = (content: string): LooseProjection => {
  const characters: string[] = [];
  const sourceIndexes: number[] = [];

  content.split('').forEach((character, index) => {
    const normalizedCharacter = normalizeLooseCharacter(character);
    if (/^[\p{L}\p{N}]$/u.test(normalizedCharacter)) {
      characters.push(normalizedCharacter);
      sourceIndexes.push(index);
      return;
    }

    if (characters[characters.length - 1] !== ' ') {
      characters.push(' ');
      sourceIndexes.push(index);
    }
  });

  return {
    text: characters.join('').trim(),
    sourceIndexes,
  };
};

export const resolveExactMatch = (
  text: string,
  selectedText: string,
  contextBefore?: string,
  contextAfter?: string
): TextMatch | undefined => {
  const normalizedSelectionPattern = buildContextRegex(selectedText);
  const exactSelectionRegex = new RegExp(normalizedSelectionPattern, 'gu');
  const normalizedBefore = normalizeWhitespace(contextBefore || '');
  const normalizedAfter = normalizeWhitespace(contextAfter || '');
  const selectionMatches = [...text.matchAll(exactSelectionRegex)];

  const match =
    selectionMatches.find(candidate => {
      const candidateIndex = candidate.index ?? 0;
      const beforeSlice = normalizeWhitespace(
        text.slice(Math.max(0, candidateIndex - 64), candidateIndex)
      );
      const afterSlice = normalizeWhitespace(
        text.slice(candidateIndex + candidate[0].length, candidateIndex + candidate[0].length + 64)
      );

      const beforeOk =
        !normalizedBefore ||
        beforeSlice.endsWith(normalizedBefore) ||
        normalizedBefore.endsWith(beforeSlice);
      const afterOk =
        !normalizedAfter ||
        afterSlice.startsWith(normalizedAfter) ||
        normalizedAfter.startsWith(afterSlice);
      return beforeOk && afterOk;
    }) || selectionMatches[0];

  if (!match) {
    return undefined;
  }

  return {
    index: match.index ?? 0,
    text: match[0],
  };
};

export const buildSourceSegments = (
  projection: VisibleProjection | LooseProjection,
  matchStart: number,
  matchLength: number
): MarkdownRange[] => {
  if (matchLength <= 0) {
    return [];
  }

  const segments: MarkdownRange[] = [];
  let segmentStart = projection.sourceIndexes[matchStart];
  let previousSourceIndex = segmentStart;

  for (let index = matchStart + 1; index < matchStart + matchLength; index += 1) {
    const currentSourceIndex = projection.sourceIndexes[index];
    if (currentSourceIndex === previousSourceIndex + 1) {
      previousSourceIndex = currentSourceIndex;
      continue;
    }

    segments.push({ start: segmentStart, end: previousSourceIndex + 1 });
    segmentStart = currentSourceIndex;
    previousSourceIndex = currentSourceIndex;
  }

  segments.push({ start: segmentStart, end: previousSourceIndex + 1 });
  return segments;
};

const splitSegmentOnParagraphBreaks = (
  content: string,
  segment: MarkdownRange
): MarkdownRange[] => {
  const segmentText = content.slice(segment.start, segment.end);
  const fragments: MarkdownRange[] = [];
  let cursor = segment.start;

  for (const match of segmentText.matchAll(PARAGRAPH_BREAK_REGEX)) {
    const breakStart = segment.start + (match.index ?? 0);
    const breakEnd = breakStart + match[0].length;

    if (cursor < breakStart) {
      fragments.push({ start: cursor, end: breakStart });
    }

    cursor = breakEnd;
  }

  if (cursor < segment.end) {
    fragments.push({ start: cursor, end: segment.end });
  }

  return fragments;
};

const isWhitespaceCharacter = (character: string | undefined): boolean => character?.trim() === '';

export const trimSegmentWhitespace = (
  content: string,
  segment: MarkdownRange
): MarkdownRange | null => {
  let start = segment.start;
  let end = segment.end;

  while (start < end && isWhitespaceCharacter(content[start])) {
    start += 1;
  }

  while (end > start && isWhitespaceCharacter(content[end - 1])) {
    end -= 1;
  }

  return start < end ? { start, end } : null;
};

const excludeProtectedRanges = (
  segment: MarkdownRange,
  protectedRanges: MarkdownRange[]
): MarkdownRange[] => {
  let fragments: MarkdownRange[] = [segment];

  protectedRanges.forEach(protectedRange => {
    fragments = fragments.flatMap(fragment => {
      if (protectedRange.end <= fragment.start || protectedRange.start >= fragment.end) {
        return [fragment];
      }

      const nextFragments: MarkdownRange[] = [];
      if (protectedRange.start > fragment.start) {
        nextFragments.push({ start: fragment.start, end: protectedRange.start });
      }
      if (protectedRange.end < fragment.end) {
        nextFragments.push({ start: protectedRange.end, end: fragment.end });
      }

      return nextFragments;
    });
  });

  return fragments;
};

interface InlineMarkdownSyntaxBalance {
  formatDelimiterCounts: Map<string, number>;
  linkDepth: number;
}

const parseInlineMarkdownSyntax = (
  value: string,
  balance: InlineMarkdownSyntaxBalance
): boolean => {
  let index = 0;

  while (index < value.length) {
    if (value[index] === '\n' || value[index] === '\r') {
      return false;
    }

    if (/\s/u.test(value[index])) {
      index += 1;
      continue;
    }

    if (value[index] === '[') {
      balance.linkDepth += 1;
      index += 1;
      continue;
    }

    if (value.startsWith('](', index)) {
      const destinationEnd = value.indexOf(')', index + 2);
      if (destinationEnd === -1) {
        return false;
      }

      balance.linkDepth -= 1;
      index = destinationEnd + 1;
      continue;
    }

    if (value[index] === '\\') {
      index += 1;
      continue;
    }

    const delimiter = INLINE_FORMAT_DELIMITERS.find(candidate =>
      value.startsWith(candidate, index)
    );
    if (!delimiter) {
      return false;
    }

    balance.formatDelimiterCounts.set(
      delimiter,
      (balance.formatDelimiterCounts.get(delimiter) || 0) + 1
    );
    index += delimiter.length;
  }

  return true;
};

const expandInlineMarkdownStart = (content: string, start: number): number => {
  let expandedStart = start;

  while (expandedStart > 0) {
    if (content[expandedStart - 1] === '[') {
      expandedStart -= 1;
      continue;
    }

    const delimiter = INLINE_FORMAT_DELIMITERS.find(
      candidate =>
        expandedStart >= candidate.length &&
        content.slice(expandedStart - candidate.length, expandedStart) === candidate
    );
    if (!delimiter) {
      break;
    }

    expandedStart -= delimiter.length;
  }

  return expandedStart;
};

const expandInlineMarkdownEnd = (content: string, end: number): number => {
  let expandedEnd = end;

  while (expandedEnd < content.length) {
    if (content.startsWith('](', expandedEnd)) {
      const destinationEnd = content.indexOf(')', expandedEnd + 2);
      if (destinationEnd === -1) {
        break;
      }

      expandedEnd = destinationEnd + 1;
      continue;
    }

    const delimiter = INLINE_FORMAT_DELIMITERS.find(candidate =>
      content.startsWith(candidate, expandedEnd)
    );
    if (!delimiter) {
      break;
    }

    expandedEnd += delimiter.length;
  }

  return expandedEnd;
};

const canBridgeInlineMarkdownGap = (
  content: string,
  left: MarkdownRange,
  right: MarkdownRange,
  protectedRanges: MarkdownRange[]
): boolean => {
  const gap = { start: left.end, end: right.start };
  if (overlapsProtectedRange(gap, protectedRanges)) {
    return false;
  }

  return parseInlineMarkdownSyntax(content.slice(gap.start, gap.end), {
    formatDelimiterCounts: new Map(),
    linkDepth: 0,
  });
};

const mergeInlineMarkdownRun = (content: string, segments: MarkdownRange[]): MarkdownRange[] => {
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  const start = expandInlineMarkdownStart(content, firstSegment.start);
  const end = expandInlineMarkdownEnd(content, lastSegment.end);
  const balance: InlineMarkdownSyntaxBalance = {
    formatDelimiterCounts: new Map(),
    linkDepth: 0,
  };
  const syntaxRanges = [
    { start, end: firstSegment.start },
    ...segments.slice(0, -1).map((segment, index) => ({
      start: segment.end,
      end: segments[index + 1].start,
    })),
    { start: lastSegment.end, end },
  ];
  const hasValidSyntax = syntaxRanges.every(range =>
    parseInlineMarkdownSyntax(content.slice(range.start, range.end), balance)
  );
  const hasBalancedFormatting = Array.from(balance.formatDelimiterCounts.values()).every(
    count => count % 2 === 0
  );

  return hasValidSyntax && balance.linkDepth === 0 && hasBalancedFormatting
    ? [{ start, end }]
    : segments;
};

const mergeInlineMarkdownSegments = (
  content: string,
  segments: MarkdownRange[],
  protectedRanges: MarkdownRange[]
): MarkdownRange[] => {
  if (segments.length === 0) {
    return [];
  }

  const runs: MarkdownRange[][] = [[segments[0]]];

  for (let index = 1; index < segments.length; index += 1) {
    const currentRun = runs[runs.length - 1];
    const currentSegment = segments[index];
    const previousSegment = currentRun[currentRun.length - 1];

    if (canBridgeInlineMarkdownGap(content, previousSegment, currentSegment, protectedRanges)) {
      currentRun.push(currentSegment);
      continue;
    }

    runs.push([currentSegment]);
  }

  return runs.flatMap(run => mergeInlineMarkdownRun(content, run));
};

export const buildMarkableSegments = (
  content: string,
  segments: MarkdownRange[],
  protectedRanges: MarkdownRange[]
): MarkdownRange[] =>
  mergeInlineMarkdownSegments(content, segments, protectedRanges)
    .flatMap(segment => splitSegmentOnParagraphBreaks(content, segment))
    .flatMap(segment => {
      const trimmedSegment = trimSegmentWhitespace(content, segment);
      if (!trimmedSegment) {
        return [];
      }

      return excludeProtectedRanges(trimmedSegment, protectedRanges)
        .map(fragment => trimSegmentWhitespace(content, fragment))
        .filter((fragment): fragment is MarkdownRange => Boolean(fragment));
    });

export const overlapsProtectedRange = (
  segment: MarkdownRange,
  protectedRanges: MarkdownRange[]
): boolean =>
  protectedRanges.some(
    protectedRange => protectedRange.start < segment.end && protectedRange.end > segment.start
  );
