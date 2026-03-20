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

interface SourceSegment {
  start: number;
  end: number;
}

const MARK_OPEN = '<mark>';
const MARK_CLOSE = '</mark>';
const MARKDOWN_TOKENS = ['***', '___', '**', '__', '~~', '`', '*', '_', '$'];

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const buildContextRegex = (value: string) =>
  escapeRegex(normalizeWhitespace(value)).replace(/\s+/g, '\\s+');

const buildVisibleProjection = (content: string): VisibleProjection => {
  const characters: string[] = [];
  const sourceIndexes: number[] = [];
  let index = 0;
  let atLineStart = true;

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
      const blockMarkerMatch = content
        .slice(index)
        .match(/^\s{0,3}(?:#{1,6}|>|-|\*|\+|\d+\.)\s+/u);

      if (blockMarkerMatch) {
        index += blockMarkerMatch[0].length;
        atLineStart = false;
        continue;
      }
    }

    const currentCharacter = content[index];

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

    const markdownToken = MARKDOWN_TOKENS.find((token) => content.startsWith(token, index));
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
    selectionMatches.find((candidate) => {
      const candidateIndex = candidate.index ?? 0;
      const beforeSlice = normalizeWhitespace(
        text.slice(Math.max(0, candidateIndex - 64), candidateIndex)
      );
      const afterSlice = normalizeWhitespace(
        text.slice(
          candidateIndex + candidate[0].length,
          candidateIndex + candidate[0].length + 64
        )
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
): SourceSegment[] => {
  if (matchLength <= 0) {
    return [];
  }

  const segments: SourceSegment[] = [];
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

const buildMarkableSegments = (content: string, segments: SourceSegment[]): SourceSegment[] =>
  segments.flatMap((segment) => {
    const segmentText = content.slice(segment.start, segment.end);
    const leadingWhitespaceLength = segmentText.match(/^\s*/u)?.[0].length ?? 0;
    const trailingWhitespaceLength = segmentText.match(/\s*$/u)?.[0].length ?? 0;
    const start = segment.start + leadingWhitespaceLength;
    const end = segment.end - trailingWhitespaceLength;

    return start < end ? [{ start, end }] : [];
  });

const isSegmentWrapped = (content: string, segment: SourceSegment) => {
  if (segment.start < MARK_OPEN.length) {
    return false;
  }

  return (
    content.slice(segment.start - MARK_OPEN.length, segment.start) === MARK_OPEN &&
    content.slice(segment.end, segment.end + MARK_CLOSE.length) === MARK_CLOSE
  );
};

const unwrapSegments = (content: string, segments: SourceSegment[]): string => {
  let updatedContent = content;

  [...segments]
    .sort((left, right) => right.start - left.start)
    .forEach((segment) => {
      updatedContent =
        updatedContent.slice(0, segment.end) +
        updatedContent.slice(segment.end + MARK_CLOSE.length);
      updatedContent =
        updatedContent.slice(0, segment.start - MARK_OPEN.length) +
        updatedContent.slice(segment.start);
    });

  return updatedContent;
};

const wrapSegments = (content: string, segments: SourceSegment[]): string => {
  let cursor = 0;
  let updatedContent = '';

  segments.forEach((segment) => {
    updatedContent += `${content.slice(cursor, segment.start)}${MARK_OPEN}${content.slice(segment.start, segment.end)}${MARK_CLOSE}`;
    cursor = segment.end;
  });

  updatedContent += content.slice(cursor);
  return updatedContent;
};

export const toggleHighlightInContent = ({
  content,
  contextAfter,
  contextBefore,
  selectedText,
}: HighlightSelectionOptions): string | null => {
  const trimmedTargetText = selectedText.trim();
  if (!trimmedTargetText) {
    return null;
  }

  const visibleProjection = buildVisibleProjection(content);
  const exactMatch = resolveExactMatch(
    visibleProjection.text,
    trimmedTargetText,
    contextBefore,
    contextAfter
  );
  const words = trimmedTargetText.match(/[\p{L}\p{N}]+/gu) || [];

  if (words.length === 0) {
    if (!exactMatch) {
      return null;
    }

    const segments = buildMarkableSegments(
      content,
      buildSourceSegments(visibleProjection, exactMatch.index, exactMatch.text.length)
    );

    if (segments.length === 0) {
      return null;
    }

    if (segments.every((segment) => isSegmentWrapped(content, segment))) {
      return unwrapSegments(content, segments);
    }

    return wrapSegments(
      content,
      segments.filter((segment) => !isSegmentWrapped(content, segment))
    );
  }

  const escapedWords = words.map((word) => escapeRegex(word));
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
      buildSourceSegments(visibleProjection, startIdx, matchedText.length)
    );

    if (segments.length === 0) {
      return null;
    }

    if (segments.every((segment) => isSegmentWrapped(content, segment))) {
      return unwrapSegments(content, segments);
    }

    return wrapSegments(
      content,
      segments.filter((segment) => !isSegmentWrapped(content, segment))
    );
  }

  if (content.includes(selectedText)) {
    return content.replace(selectedText, `${MARK_OPEN}${selectedText}${MARK_CLOSE}`);
  }

  return null;
};
