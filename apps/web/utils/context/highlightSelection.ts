import {
  getMarkdownProtectedRanges,
  type MarkdownRange,
  normalizeMathSelectionArtifacts,
} from '../markdown/codeRanges.ts';

import {
  buildContextRegex,
  buildLooseProjection,
  buildMarkableSegments,
  buildSourceLooseProjection,
  buildSourceSegments,
  buildVisibleProjection,
  escapeRegex,
  normalizeLooseText,
  overlapsProtectedRange,
  resolveExactMatch,
} from '../markdown/textProjection.ts';

export interface HighlightSelectionOptions {
  content: string;
  contextAfter?: string;
  contextBefore?: string;
  selectedText: string;
}

const MARK_OPEN = '<mark>';
const MARK_CLOSE = '</mark>';

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
        buildSourceSegments(looseProjection, looseMatch.index ?? 0, looseMatch[0].length),
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
