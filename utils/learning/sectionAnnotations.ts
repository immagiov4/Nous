import type { SectionAnnotation } from '../../types.ts';
import {
  getMarkdownMathRangeAt,
  getMarkdownProtectedRanges,
  type MarkdownRange,
  normalizeMathSelectionArtifacts,
  projectMarkdownMathRange,
} from '../markdown/codeRanges.ts';

const MARK_CLOSE = '</mark>';
const MARK_OPEN_WITH_ID = (annotationId: string) =>
  `<mark data-lumina-annotation-id="${annotationId}">`;
const MARK_OPEN_TAG_REGEX = /^<mark\b[^>]*>/iu;
const ANNOTATION_ID_REGEX = /\bdata-lumina-annotation-id=(["'])([^"']+)\1/iu;
const PARAGRAPH_BREAK_REGEX = /\n(?:[ \t]*\n)+/gu;
const MARKDOWN_TOKENS = ['***', '___', '**', '__', '~~', '`', '*', '_', '$'];
const LEGACY_GROUP_GAP_TOKENS_REGEX =
  /(?:\s+|[*_~`]+|(?:^|\n)\s{0,3}(?:#{1,6}|>|-|\*|\+|\d+\.)\s*)/gu;

export const NOTE_MERGE_SEPARATOR = '\n\n---\n\n';

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

interface ParsedMarkSegment extends MarkdownRange {
  annotationId?: string;
  closeTagEnd: number;
  closeTagStart: number;
  openTagEnd: number;
  openTagStart: number;
  text: string;
}

interface ParsedAnnotationGroup {
  annotation: SectionAnnotation;
  segments: ParsedMarkSegment[];
}

interface ApplySectionAnnotationOptions {
  annotations?: SectionAnnotation[];
  content: string;
  contextAfter?: string;
  contextBefore?: string;
  createId?: () => string;
  note?: string;
  now?: string;
  preferredAnnotationId?: string;
  selectedText: string;
}

interface ApplySectionAnnotationResult {
  annotationId: string;
  annotations: SectionAnnotation[];
  content: string;
  merged: boolean;
  resolvedText: string;
}

interface RemoveSectionAnnotationResult {
  annotations: SectionAnnotation[];
  content: string;
  removed: boolean;
}

interface UpdateSectionAnnotationNoteResult {
  annotation: SectionAnnotation;
  annotations: SectionAnnotation[];
}

interface MigrateSectionAnnotationsResult {
  annotations: SectionAnnotation[];
  content: string;
  didChange: boolean;
}

interface FindSectionAnnotationForSelectionResult {
  annotation: SectionAnnotation;
  resolvedText: string;
}

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

const normalizeLooseText = (value: string): string =>
  normalizeLooseCharacter(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const createAnnotationId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `annotation-${crypto.randomUUID()}`;
  }

  return `annotation-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

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

const overlapsProtectedRange = (
  segment: MarkdownRange,
  protectedRanges: MarkdownRange[]
): boolean =>
  protectedRanges.some(
    protectedRange => protectedRange.start < segment.end && protectedRange.end > segment.start
  );

const resolveSelectedSegments = ({
  content,
  contextAfter,
  contextBefore,
  selectedText,
}: Pick<
  ApplySectionAnnotationOptions,
  'content' | 'contextAfter' | 'contextBefore' | 'selectedText'
>): MarkdownRange[] => {
  const trimmedTargetText = normalizeMathSelectionArtifacts(selectedText).trim();
  if (!trimmedTargetText) {
    return [];
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
      return [];
    }

    return buildMarkableSegments(
      content,
      buildSourceSegments(visibleProjection, exactMatch.index, exactMatch.text.length),
      protectedRanges
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

const parseMarkSegments = (content: string): ParsedMarkSegment[] => {
  const protectedRanges = getMarkdownProtectedRanges(content);
  const segments: ParsedMarkSegment[] = [];
  const openStack: Array<{
    annotationId?: string;
    openTagEnd: number;
    openTagStart: number;
  }> = [];
  let protectedIndex = 0;
  let index = 0;

  while (index < content.length) {
    const protectedRange = protectedRanges[protectedIndex];

    if (protectedRange && index >= protectedRange.end) {
      protectedIndex += 1;
      continue;
    }

    if (protectedRange && index >= protectedRange.start) {
      index = protectedRange.end;
      continue;
    }

    if (content.startsWith(MARK_CLOSE, index)) {
      const openTag = openStack.pop();
      if (openTag) {
        segments.push({
          annotationId: openTag.annotationId,
          closeTagEnd: index + MARK_CLOSE.length,
          closeTagStart: index,
          end: index,
          openTagEnd: openTag.openTagEnd,
          openTagStart: openTag.openTagStart,
          start: openTag.openTagEnd,
          text: content.slice(openTag.openTagEnd, index),
        });
      }
      index += MARK_CLOSE.length;
      continue;
    }

    const openTagMatch = content.slice(index).match(MARK_OPEN_TAG_REGEX);
    if (openTagMatch) {
      const tag = openTagMatch[0];
      const annotationIdMatch = tag.match(ANNOTATION_ID_REGEX);
      openStack.push({
        annotationId: annotationIdMatch?.[2],
        openTagEnd: index + tag.length,
        openTagStart: index,
      });
      index += tag.length;
      continue;
    }

    index += 1;
  }

  return segments;
};

const mergeGapForLegacyGroup = (gap: string): boolean =>
  gap.replace(LEGACY_GROUP_GAP_TOKENS_REGEX, '').length === 0;

const groupLegacySegmentsByContent = (
  content: string,
  segments: ParsedMarkSegment[]
): ParsedMarkSegment[][] => {
  if (segments.length === 0) {
    return [];
  }

  const groups: ParsedMarkSegment[][] = [[segments[0]]];

  for (let index = 1; index < segments.length; index += 1) {
    const previousSegment = segments[index - 1];
    const currentSegment = segments[index];
    const gap = content.slice(previousSegment.closeTagEnd, currentSegment.openTagStart);

    if (mergeGapForLegacyGroup(gap)) {
      groups[groups.length - 1].push(currentSegment);
      continue;
    }

    groups.push([currentSegment]);
  }

  return groups;
};

const sortRanges = <TRange extends MarkdownRange>(ranges: TRange[]): TRange[] =>
  [...ranges].sort((left, right) => left.start - right.start);

const mergeRanges = (ranges: MarkdownRange[]): MarkdownRange[] => {
  if (ranges.length <= 1) {
    return sortRanges(ranges);
  }

  const sortedRanges = sortRanges(ranges);
  const mergedRanges: MarkdownRange[] = [{ ...sortedRanges[0] }];

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

const annotationSegmentsOverlap = (left: MarkdownRange, right: MarkdownRange) =>
  left.start < right.end && right.start < left.end;

const removeRangesFromContent = (content: string, ranges: MarkdownRange[]) => {
  if (ranges.length === 0) {
    return content;
  }

  let updatedContent = content;
  sortRanges(ranges)
    .reverse()
    .forEach(range => {
      updatedContent = `${updatedContent.slice(0, range.start)}${updatedContent.slice(range.end)}`;
    });
  return updatedContent;
};

const mapPositionAfterRemovingRanges = (position: number, removedRanges: MarkdownRange[]) =>
  removedRanges.reduce((shiftedPosition, range) => {
    if (range.end <= position) {
      return shiftedPosition - (range.end - range.start);
    }

    return shiftedPosition;
  }, position);

const remapRangesAfterRemoving = (ranges: MarkdownRange[], removedRanges: MarkdownRange[]) =>
  ranges.map(range => ({
    start: mapPositionAfterRemovingRanges(range.start, removedRanges),
    end: mapPositionAfterRemovingRanges(range.end, removedRanges),
  }));

const wrapRangesWithAnnotation = (
  content: string,
  annotationId: string,
  ranges: MarkdownRange[]
): string => {
  if (ranges.length === 0) {
    return content;
  }

  let updatedContent = content;
  const openTag = MARK_OPEN_WITH_ID(annotationId);

  sortRanges(ranges)
    .reverse()
    .forEach(range => {
      updatedContent = `${updatedContent.slice(0, range.end)}${MARK_CLOSE}${updatedContent.slice(range.end)}`;
      updatedContent = `${updatedContent.slice(0, range.start)}${openTag}${updatedContent.slice(range.start)}`;
    });

  return updatedContent;
};

const buildGroupsById = (
  annotations: SectionAnnotation[] | undefined,
  segments: ParsedMarkSegment[]
): ParsedAnnotationGroup[] => {
  const annotationById = new Map(
    (annotations || []).map(annotation => [annotation.id, annotation])
  );
  const now = new Date().toISOString();
  const groups = new Map<string, ParsedMarkSegment[]>();

  segments
    .filter(
      (segment): segment is ParsedMarkSegment & { annotationId: string } =>
        typeof segment.annotationId === 'string' && segment.annotationId.length > 0
    )
    .forEach(segment => {
      const currentSegments = groups.get(segment.annotationId) || [];
      currentSegments.push(segment);
      groups.set(segment.annotationId, currentSegments);
    });

  return Array.from(groups.entries())
    .map(([annotationId, groupedSegments]) => ({
      annotation: annotationById.get(annotationId) || {
        id: annotationId,
        note: '',
        createdAt: now,
        updatedAt: now,
      },
      segments: sortRanges(groupedSegments) as ParsedMarkSegment[],
    }))
    .sort((left, right) => left.segments[0].start - right.segments[0].start);
};

const buildAnnotationText = (content: string, segments: MarkdownRange[]) =>
  normalizeWhitespace(segments.map(segment => content.slice(segment.start, segment.end)).join(' '));

const sortAnnotationsByDocumentOrder = (
  content: string,
  annotations: SectionAnnotation[]
): SectionAnnotation[] => {
  const groups = buildGroupsById(annotations, parseMarkSegments(content));
  const positionById = new Map(groups.map(group => [group.annotation.id, group.segments[0].start]));

  return [...annotations].sort((left, right) => {
    const leftPosition = positionById.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightPosition = positionById.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftPosition !== rightPosition) {
      return leftPosition - rightPosition;
    }

    return left.createdAt.localeCompare(right.createdAt);
  });
};

export const getSectionAnnotationText = (content: string, annotationId: string): string => {
  const groups = buildGroupsById(undefined, parseMarkSegments(content));
  const group = groups.find(candidate => candidate.annotation.id === annotationId);
  if (!group) {
    return '';
  }

  return buildAnnotationText(content, group.segments);
};

const getRangeOverlapLength = (left: MarkdownRange, right: MarkdownRange) => {
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
};

export const findSectionAnnotationForSelection = ({
  annotations,
  content,
  contextAfter,
  contextBefore,
  selectedText,
}: Pick<
  ApplySectionAnnotationOptions,
  'annotations' | 'content' | 'contextAfter' | 'contextBefore' | 'selectedText'
>): FindSectionAnnotationForSelectionResult | null => {
  const selectedSegments = resolveSelectedSegments({
    content,
    contextAfter,
    contextBefore,
    selectedText,
  });

  if (selectedSegments.length === 0) {
    return null;
  }

  const normalizedSelectedText = normalizeWhitespace(selectedText);
  const annotationGroups = buildGroupsById(annotations, parseMarkSegments(content))
    .map(group => ({
      group,
      overlapLength: group.segments.reduce(
        (totalOverlap, annotationSegment) =>
          totalOverlap +
          selectedSegments.reduce(
            (segmentOverlap, selectedSegment) =>
              segmentOverlap + getRangeOverlapLength(annotationSegment, selectedSegment),
            0
          ),
        0
      ),
      resolvedText: buildAnnotationText(content, group.segments),
    }))
    .filter(candidate => candidate.overlapLength > 0);

  if (annotationGroups.length === 0) {
    return null;
  }

  annotationGroups.sort((left, right) => {
    const leftExact = normalizeWhitespace(left.resolvedText) === normalizedSelectedText;
    const rightExact = normalizeWhitespace(right.resolvedText) === normalizedSelectedText;
    if (leftExact !== rightExact) {
      return rightExact ? 1 : -1;
    }

    const leftContains =
      normalizeWhitespace(left.resolvedText).includes(normalizedSelectedText) ||
      normalizedSelectedText.includes(normalizeWhitespace(left.resolvedText));
    const rightContains =
      normalizeWhitespace(right.resolvedText).includes(normalizedSelectedText) ||
      normalizedSelectedText.includes(normalizeWhitespace(right.resolvedText));
    if (leftContains !== rightContains) {
      return rightContains ? 1 : -1;
    }

    if (left.overlapLength !== right.overlapLength) {
      return right.overlapLength - left.overlapLength;
    }

    return left.group.segments[0].start - right.group.segments[0].start;
  });

  const bestMatch = annotationGroups[0];
  return bestMatch
    ? {
        annotation: bestMatch.group.annotation,
        resolvedText: bestMatch.resolvedText,
      }
    : null;
};

export const migrateSectionAnnotations = ({
  annotations,
  content,
  createId = createAnnotationId,
  now = new Date().toISOString(),
}: {
  annotations?: SectionAnnotation[];
  content: string;
  createId?: () => string;
  now?: string;
}): MigrateSectionAnnotationsResult => {
  const segments = parseMarkSegments(content);
  const groupedAnnotations = buildGroupsById(annotations, segments);
  const legacyGroups = groupLegacySegmentsByContent(
    content,
    segments.filter(segment => !segment.annotationId)
  );

  const tagReplacements = new Map<number, { end: number; replacement: string }>();

  groupedAnnotations.forEach(group => {
    group.segments.forEach(segment => {
      tagReplacements.set(segment.openTagStart, {
        end: segment.openTagEnd,
        replacement: MARK_OPEN_WITH_ID(group.annotation.id),
      });
    });
  });

  const migratedLegacyAnnotations = legacyGroups.map(group => {
    const annotationId = createId();
    group.forEach(segment => {
      tagReplacements.set(segment.openTagStart, {
        end: segment.openTagEnd,
        replacement: MARK_OPEN_WITH_ID(annotationId),
      });
    });

    return {
      annotation: {
        id: annotationId,
        note: '',
        createdAt: now,
        updatedAt: now,
      },
      segments: group,
    };
  });

  let nextContent = content;
  Array.from(tagReplacements.entries())
    .sort((left, right) => right[0] - left[0])
    .forEach(([start, { end, replacement }]) => {
      nextContent = `${nextContent.slice(0, start)}${replacement}${nextContent.slice(end)}`;
    });

  const nextAnnotations = sortAnnotationsByDocumentOrder(
    nextContent,
    [...groupedAnnotations, ...migratedLegacyAnnotations].map(group => group.annotation)
  );
  const didChange =
    nextContent !== content ||
    JSON.stringify(nextAnnotations) !== JSON.stringify(annotations || []);

  return {
    annotations: nextAnnotations,
    content: nextContent,
    didChange,
  };
};

export const applySectionAnnotation = ({
  annotations,
  content,
  contextAfter,
  contextBefore,
  createId = createAnnotationId,
  note = '',
  now = new Date().toISOString(),
  preferredAnnotationId,
  selectedText,
}: ApplySectionAnnotationOptions): ApplySectionAnnotationResult | null => {
  const selectedSegments = resolveSelectedSegments({
    content,
    contextAfter,
    contextBefore,
    selectedText,
  });

  if (selectedSegments.length === 0) {
    return null;
  }

  const annotationGroups = buildGroupsById(annotations, parseMarkSegments(content));
  const absorbedGroups = annotationGroups.filter(group =>
    group.segments.some(existingSegment =>
      selectedSegments.some(selectedSegment =>
        annotationSegmentsOverlap(existingSegment, selectedSegment)
      )
    )
  );

  const absorbedAnnotationIds = new Set(absorbedGroups.map(group => group.annotation.id));
  const combinedSegments = mergeRanges([
    ...selectedSegments,
    ...absorbedGroups.flatMap(group => group.segments),
  ]);
  const removedRanges = sortRanges(
    absorbedGroups.flatMap(group =>
      group.segments.flatMap(segment => [
        { start: segment.openTagStart, end: segment.openTagEnd },
        { start: segment.closeTagStart, end: segment.closeTagEnd },
      ])
    )
  );

  const annotationId =
    preferredAnnotationId ||
    absorbedGroups.find(group => group.annotation.id)?.annotation.id ||
    createId();
  const strippedContent = removeRangesFromContent(content, removedRanges);
  const remappedSegments = remapRangesAfterRemoving(combinedSegments, removedRanges);
  const nextContent = wrapRangesWithAnnotation(strippedContent, annotationId, remappedSegments);
  const resolvedText = buildAnnotationText(strippedContent, remappedSegments);
  const trimmedNote = note.trim();
  const absorbedNotes = absorbedGroups
    .sort((left, right) => left.segments[0].start - right.segments[0].start)
    .map(group => group.annotation.note.trim())
    .filter(Boolean);
  const mergedNote = [trimmedNote, ...absorbedNotes].filter(Boolean).join(NOTE_MERGE_SEPARATOR);
  const earliestCreatedAt =
    absorbedGroups
      .map(group => group.annotation.createdAt)
      .sort((left, right) => left.localeCompare(right))[0] || now;
  const retainedAnnotations = (annotations || []).filter(
    annotation => !absorbedAnnotationIds.has(annotation.id) && annotation.id !== annotationId
  );
  const nextAnnotations = sortAnnotationsByDocumentOrder(nextContent, [
    ...retainedAnnotations,
    {
      createdAt: earliestCreatedAt,
      id: annotationId,
      note: mergedNote,
      updatedAt: now,
    },
  ]);

  return {
    annotationId,
    annotations: nextAnnotations,
    content: nextContent,
    merged: absorbedGroups.length > 0,
    resolvedText,
  };
};

export const updateSectionAnnotationNote = ({
  annotationId,
  annotations,
  note,
  now = new Date().toISOString(),
}: {
  annotationId: string;
  annotations?: SectionAnnotation[];
  note: string;
  now?: string;
}): UpdateSectionAnnotationNoteResult | null => {
  const existingAnnotation = (annotations || []).find(annotation => annotation.id === annotationId);
  if (!existingAnnotation) {
    return null;
  }

  const nextAnnotation = {
    ...existingAnnotation,
    note: note.trim(),
    updatedAt: now,
  };

  return {
    annotation: nextAnnotation,
    annotations: (annotations || []).map(annotation =>
      annotation.id === annotationId ? nextAnnotation : annotation
    ),
  };
};

export const removeSectionAnnotation = ({
  annotationId,
  annotations,
  content,
}: {
  annotationId: string;
  annotations?: SectionAnnotation[];
  content: string;
}): RemoveSectionAnnotationResult => {
  const annotationGroups = buildGroupsById(annotations, parseMarkSegments(content));
  const removedGroup = annotationGroups.find(group => group.annotation.id === annotationId);
  if (!removedGroup) {
    return {
      annotations: annotations || [],
      content,
      removed: false,
    };
  }

  const removedRanges = removedGroup.segments.flatMap(segment => [
    { start: segment.openTagStart, end: segment.openTagEnd },
    { start: segment.closeTagStart, end: segment.closeTagEnd },
  ]);

  return {
    annotations: (annotations || []).filter(annotation => annotation.id !== annotationId),
    content: removeRangesFromContent(content, removedRanges),
    removed: true,
  };
};
