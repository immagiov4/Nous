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
  trimSegmentWhitespace,
} from '../markdown/textProjection.ts';

export interface ResolveSelectedSegmentsOptions {
  content: string;
  contextAfter?: string;
  contextBefore?: string;
  selectedText: string;
  selectedTextStart?: number;
}

export { normalizeWhitespace } from '../markdown/textProjection.ts';

export const resolveSelectedSegments = ({
  content,
  contextAfter,
  contextBefore,
  selectedText,
  selectedTextStart,
}: ResolveSelectedSegmentsOptions): MarkdownRange[] => {
  const trimmedTargetText = normalizeMathSelectionArtifacts(selectedText).trim();
  if (!trimmedTargetText) {
    return [];
  }

  const visibleProjection = buildVisibleProjection(content);
  const looseProjection = buildLooseProjection(content);
  const sourceLooseProjection = buildSourceLooseProjection(content);
  const protectedRanges = getMarkdownProtectedRanges(content);
  const hasSelectionContext = Boolean(contextBefore || contextAfter);
  const exactMatch = resolveExactMatch(
    visibleProjection.text,
    trimmedTargetText,
    contextBefore ? normalizeMathSelectionArtifacts(contextBefore) : contextBefore,
    contextAfter ? normalizeMathSelectionArtifacts(contextAfter) : contextAfter,
    hasSelectionContext,
    selectedTextStart
  );
  const words = trimmedTargetText.match(/[\p{L}\p{N}]+/gu) || [];

  if (words.length === 0) {
    if (!exactMatch) {
      return [];
    }

    return buildMarkableSegments(
      content,
      buildSourceSegments(visibleProjection, exactMatch.index, exactMatch.text.length),
      protectedRanges
    );
  }

  const escapedWords = words.map(word => escapeRegex(word));
  const junkPattern = String.raw`[^\p{L}\p{N}]+`;
  const pattern = escapedWords.join(junkPattern);
  const wordChar = String.raw`[\p{L}\p{N}]`;
  const expandedPattern = `${wordChar}*${pattern}${wordChar}*`;
  const fuzzyRegex = new RegExp(expandedPattern, 'iu');
  const shouldPreferExact = /[^\p{L}\p{N}]/u.test(trimmedTargetText);
  const fuzzyMatch = visibleProjection.text.match(fuzzyRegex);
  const match = hasSelectionContext
    ? exactMatch
    : shouldPreferExact
      ? exactMatch || fuzzyMatch
      : fuzzyMatch || exactMatch;

  if (hasSelectionContext && !match) {
    return [];
  }

  if (match) {
    const matchedText = 'text' in match ? match.text : match[0];
    const startIdx = match.index ?? 0;
    return buildMarkableSegments(
      content,
      buildSourceSegments(visibleProjection, startIdx, matchedText.length),
      protectedRanges
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
        return segments;
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
        return segments;
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
    const trimmedSegment = trimSegmentWhitespace(content, {
      start: rawMatchIndex,
      end: rawMatchIndex + selectedText.length,
    });
    return trimmedSegment ? [trimmedSegment] : [];
  }

  return [];
};
