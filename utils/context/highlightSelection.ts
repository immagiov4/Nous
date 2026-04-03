import {
  getMarkdownMathRangeAt,
  getMarkdownProtectedRanges,
  normalizeMathSelectionArtifacts,
  projectMarkdownMathRange,
  type MarkdownRange,
} from '../markdown/codeRanges.ts';

export interface HighlightSelectionOptions {
  content: string;
  contextAfter?: string;
  contextBefore?: string;
  selectedText: string;
}

interface VisibleProjection {
  sourceIndexes: number[];
  text: string;
}

interface TextMatch {
  index: number;
  text: string;
}

interface LooseProjection {
  sourceIndexes: number[];
  text: string;
}

const MARK_OPEN = '<mark>';
const MARK_CLOSE = '</mark>';
const MARKDOWN_TOKENS = ['***', '___', '**', '__', '~~', '`', '*', '_', '$'];
const PARAGRAPH_BREAK_REGEX = /\n(?:[ \t]*\n)+/gu;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const buildContextRegex = (value: string) =>
  escapeRegex(normalizeWhitespace(value)).replace(/\s+/g, '\\s+');

const normalizeLooseCharacter = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .toLowerCase();

const buildVisibleProjection = (content: string): VisibleProjection => {
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
    if (content.startsWith('{{PDF_IMAGE:', index)) {
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
        pushCharacter(
          character,
          mathProjection.sourceIndexes[projectionIndex] ?? mathRange.start
        );
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

const buildLooseProjection = (content: string): LooseProjection => {
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

const buildSourceLooseProjection = (content: string): LooseProjection => {
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

const normalizeLooseText = (value: string): string =>
  normalizeLooseCharacter(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const resolveExactMatch = (
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

const buildSourceSegments = (
  projection: VisibleProjection,
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

const trimSegmentWhitespace = (content: string, segment: MarkdownRange): MarkdownRange | null => {
  const segmentText = content.slice(segment.start, segment.end);
  const leadingWhitespaceLength = segmentText.match(/^\s*/u)?.[0].length ?? 0;
  const trailingWhitespaceLength = segmentText.match(/\s*$/u)?.[0].length ?? 0;
  const start = segment.start + leadingWhitespaceLength;
  const end = segment.end - trailingWhitespaceLength;

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

const buildMarkableSegments = (
  content: string,
  segments: MarkdownRange[],
  protectedRanges: MarkdownRange[]
): MarkdownRange[] =>
  segments
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

const isSegmentWrapped = (content: string, segment: MarkdownRange) => {
  if (segment.start < MARK_OPEN.length) {
    return false;
  }

  return (
    content.slice(segment.start - MARK_OPEN.length, segment.start) === MARK_OPEN &&
    content.slice(segment.end, segment.end + MARK_CLOSE.length) === MARK_CLOSE
  );
};

const unwrapSegments = (content: string, segments: MarkdownRange[]): string => {
  let updatedContent = content;

  [...segments]
    .sort((left, right) => right.start - left.start)
    .forEach(segment => {
      updatedContent =
        updatedContent.slice(0, segment.end) +
        updatedContent.slice(segment.end + MARK_CLOSE.length);
      updatedContent =
        updatedContent.slice(0, segment.start - MARK_OPEN.length) +
        updatedContent.slice(segment.start);
    });

  return updatedContent;
};

const wrapSegments = (content: string, segments: MarkdownRange[]): string => {
  let cursor = 0;
  let updatedContent = '';

  segments.forEach(segment => {
    updatedContent += `${content.slice(cursor, segment.start)}${MARK_OPEN}${content.slice(segment.start, segment.end)}${MARK_CLOSE}`;
    cursor = segment.end;
  });

  updatedContent += content.slice(cursor);
  return updatedContent;
};

const overlapsProtectedRange = (
  segment: MarkdownRange,
  protectedRanges: MarkdownRange[]
): boolean =>
  protectedRanges.some(
    protectedRange => protectedRange.start < segment.end && protectedRange.end > segment.start
  );

export const toggleHighlightInContent = ({
  content,
  contextAfter,
  contextBefore,
  selectedText,
}: HighlightSelectionOptions): string | null => {
  const trimmedTargetText = normalizeMathSelectionArtifacts(selectedText).trim();
  if (!trimmedTargetText) {
    return null;
  }

  const visibleProjection = buildVisibleProjection(content);
  const looseProjection = buildLooseProjection(content);
  const sourceLooseProjection = buildSourceLooseProjection(content);
  const protectedRanges = getMarkdownProtectedRanges(content);
  const exactMatch = resolveExactMatch(
    visibleProjection.text,
    trimmedTargetText,
    contextBefore ? normalizeMathSelectionArtifacts(contextBefore) : contextBefore,
    contextAfter ? normalizeMathSelectionArtifacts(contextAfter) : contextAfter
  );
  const words = trimmedTargetText.match(/[\p{L}\p{N}]+/gu) || [];

  if (words.length === 0) {
    if (!exactMatch) {
      return null;
    }

    const segments = buildMarkableSegments(
      content,
      buildSourceSegments(visibleProjection, exactMatch.index, exactMatch.text.length),
      protectedRanges
    );

    if (segments.length === 0) {
      return null;
    }

    if (segments.every(segment => isSegmentWrapped(content, segment))) {
      return unwrapSegments(content, segments);
    }

    return wrapSegments(
      content,
      segments.filter(segment => !isSegmentWrapped(content, segment))
    );
  }

  const escapedWords = words.map(word => escapeRegex(word));
  const junkPattern = '[^\\p{L}\\p{N}]+';
  const pattern = escapedWords.join(junkPattern);
  const wordChar = '[\\p{L}\\p{N}]';
  const expandedPattern = `${wordChar}*${pattern}${wordChar}*`;
  const fuzzyRegex = new RegExp(expandedPattern, 'iu');
  const shouldPreferExact = /[^\p{L}\p{N}]/u.test(trimmedTargetText);
  const fuzzyMatch = visibleProjection.text.match(fuzzyRegex);
  const match = shouldPreferExact ? exactMatch || fuzzyMatch : fuzzyMatch || exactMatch;

  if (match) {
    const matchedText = 'text' in match ? match.text : match[0];
    const startIdx = match.index ?? 0;
    const segments = buildMarkableSegments(
      content,
      buildSourceSegments(visibleProjection, startIdx, matchedText.length),
      protectedRanges
    );

    if (segments.length === 0) {
      return null;
    }

    if (segments.every(segment => isSegmentWrapped(content, segment))) {
      return unwrapSegments(content, segments);
    }

    return wrapSegments(
      content,
      segments.filter(segment => !isSegmentWrapped(content, segment))
    );
  }

  const normalizedLooseSelection = normalizeLooseText(trimmedTargetText);
  if (normalizedLooseSelection) {
    const looseRegex = new RegExp(buildContextRegex(normalizedLooseSelection), 'u');
    const looseMatch = looseProjection.text.match(looseRegex);

    if (looseMatch) {
      const segments = buildMarkableSegments(
        content,
        buildSourceSegments(
          looseProjection,
          looseMatch.index ?? 0,
          looseMatch[0].length
        ),
        protectedRanges
      );

      if (segments.length > 0) {
        if (segments.every(segment => isSegmentWrapped(content, segment))) {
          return unwrapSegments(content, segments);
        }

        return wrapSegments(
          content,
          segments.filter(segment => !isSegmentWrapped(content, segment))
        );
      }
    }

    const sourceLooseMatch = sourceLooseProjection.text.match(looseRegex);

    if (sourceLooseMatch) {
      const segments = buildMarkableSegments(
        content,
        buildSourceSegments(
          sourceLooseProjection,
          sourceLooseMatch.index ?? 0,
          sourceLooseMatch[0].length
        ),
        protectedRanges
      );

      if (segments.length > 0) {
        if (segments.every(segment => isSegmentWrapped(content, segment))) {
          return unwrapSegments(content, segments);
        }

        return wrapSegments(
          content,
          segments.filter(segment => !isSegmentWrapped(content, segment))
        );
      }
    }
  }

  const rawMatchIndex = content.indexOf(selectedText);
  if (
    rawMatchIndex !== -1 &&
    !overlapsProtectedRange(
      { start: rawMatchIndex, end: rawMatchIndex + selectedText.length },
      protectedRanges
    )
  ) {
    return content.replace(selectedText, `${MARK_OPEN}${selectedText}${MARK_CLOSE}`);
  }

  return null;
};
