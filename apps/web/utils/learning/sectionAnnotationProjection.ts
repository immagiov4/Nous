import {
  getMarkdownAnnotationProtectedRanges,
  type MarkdownRange,
  normalizeMathSelectionArtifacts,
  parseMarkdownAnalysis,
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
  normalizeWhitespace,
  overlapsProtectedRange,
  resolveExactMatch,
  trimSegmentWhitespace,
} from '../markdown/textProjection.ts';

export interface PreferredAnnotationSelection {
  contextAfter?: string;
  contextBefore?: string;
  selectedText: string;
  selectedTextStart?: number;
}

export interface ResolveSelectedSegmentsOptions {
  content: string;
  contextAfter?: string;
  contextBefore?: string;
  preferredSelection?: PreferredAnnotationSelection;
  selectedText: string;
  selectedTextStart?: number;
}

export { normalizeWhitespace } from '../markdown/textProjection.ts';

const normalizeOptionalMathSelectionText = (value: string | undefined): string | undefined =>
  value ? normalizeMathSelectionArtifacts(value) : value;

interface PrimarySelectionMatchOptions {
  exactMatch: ReturnType<typeof resolveExactMatch>;
  fuzzyMatch: RegExpMatchArray | null;
  hasSelectedTextStart: boolean;
  hasSelectionContext: boolean;
  shouldPreferExact: boolean;
}

const selectPrimarySelectionMatch = ({
  exactMatch,
  fuzzyMatch,
  hasSelectedTextStart,
  hasSelectionContext,
  shouldPreferExact,
}: PrimarySelectionMatchOptions) => {
  if (hasSelectionContext || (hasSelectedTextStart && exactMatch)) {
    return exactMatch;
  }
  if (shouldPreferExact) {
    return exactMatch || fuzzyMatch;
  }
  return fuzzyMatch || exactMatch;
};

export const normalizeSectionAnnotationSelectionText = (value: string): string => {
  const mathNormalizedText = normalizeMathSelectionArtifacts(value).trim();
  return normalizeWhitespace(
    mathNormalizedText
      .normalize('NFD')
      .replaceAll(/[\u0300-\u036f]/g, '')
      .replaceAll(/[\u2018\u2019]/g, "'")
      .replaceAll(/[\u201C\u201D]/g, '"')
      .replaceAll(/[\u2010-\u2015\u2212]/g, '-')
      .toLowerCase()
  );
};

export const resolveSelectedSegments = ({
  content,
  contextAfter,
  contextBefore,
  preferredSelection,
  selectedText,
  selectedTextStart,
}: ResolveSelectedSegmentsOptions): MarkdownRange[] => {
  const trimmedTargetText = normalizeMathSelectionArtifacts(selectedText).trim();
  if (!trimmedTargetText) {
    return [];
  }

  const analysis = parseMarkdownAnalysis(content);
  const visibleProjection = buildVisibleProjection(content, analysis);
  let preferredSelectionMatch: ReturnType<typeof resolveExactMatch>;
  if (preferredSelection) {
    preferredSelectionMatch = resolveExactMatch(
      visibleProjection.text,
      normalizeMathSelectionArtifacts(preferredSelection.selectedText).trim(),
      normalizeOptionalMathSelectionText(preferredSelection.contextBefore),
      normalizeOptionalMathSelectionText(preferredSelection.contextAfter),
      Boolean(preferredSelection.contextBefore || preferredSelection.contextAfter),
      preferredSelection.selectedTextStart
    );
  }
  const preferredRange = preferredSelectionMatch
    ? {
        start: preferredSelectionMatch.index,
        end: preferredSelectionMatch.index + preferredSelectionMatch.text.length,
      }
    : undefined;
  const looseProjection = buildLooseProjection(content, visibleProjection);
  const sourceLooseProjection = buildSourceLooseProjection(content);
  const protectedRanges = getMarkdownAnnotationProtectedRanges(content, analysis);
  const hasSelectionContext = Boolean(contextBefore || contextAfter);
  const exactMatch = resolveExactMatch(
    visibleProjection.text,
    trimmedTargetText,
    normalizeOptionalMathSelectionText(contextBefore),
    normalizeOptionalMathSelectionText(contextAfter),
    hasSelectionContext,
    selectedTextStart,
    preferredRange
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
  const match = selectPrimarySelectionMatch({
    exactMatch,
    fuzzyMatch,
    hasSelectedTextStart: selectedTextStart !== undefined,
    hasSelectionContext,
    shouldPreferExact,
  });

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
