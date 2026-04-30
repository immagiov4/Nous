import type { SectionAnnotation } from '../../types.ts';
import { getMarkdownProtectedRanges, type MarkdownRange } from '../markdown/codeRanges.ts';
import { timestampIso } from '../time.ts';
import { normalizeWhitespace } from './sectionAnnotationProjection.ts';

export const MARK_CLOSE = '</mark>';
export const MARK_OPEN_WITH_ID = (annotationId: string) =>
  `<mark data-nous-annotation-id="${annotationId}">`;

const MARK_OPEN_TAG_REGEX = /^<mark\b[^>]*>/iu;
const ANNOTATION_ID_REGEX = /\bdata-(?:nous|lumina)-annotation-id=(["'])([^"']+)\1/iu;
const LEGACY_GROUP_GAP_TOKENS_REGEX =
  /(?:\s+|[*_~`]+|(?:^|\n)\s{0,3}(?:#{1,6}|>|-|\*|\+|\d+\.)\s*)/gu;

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

export const parseMarkSegments = (content: string): ParsedMarkSegment[] => {
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

export const groupLegacySegmentsByContent = (
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

export const sortRanges = <TRange extends MarkdownRange>(ranges: TRange[]): TRange[] =>
  [...ranges].sort((left, right) => left.start - right.start);

export const mergeRanges = (ranges: MarkdownRange[]): MarkdownRange[] => {
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

export const annotationSegmentsOverlap = (left: MarkdownRange, right: MarkdownRange) =>
  left.start < right.end && right.start < left.end;

export const removeRangesFromContent = (content: string, ranges: MarkdownRange[]) => {
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

export const remapRangesAfterRemoving = (ranges: MarkdownRange[], removedRanges: MarkdownRange[]) =>
  ranges.map(range => ({
    start: mapPositionAfterRemovingRanges(range.start, removedRanges),
    end: mapPositionAfterRemovingRanges(range.end, removedRanges),
  }));

export const wrapRangesWithAnnotation = (
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

export const buildGroupsById = (
  annotations: SectionAnnotation[] | undefined,
  segments: ParsedMarkSegment[]
): ParsedAnnotationGroup[] => {
  const annotationById = new Map(
    (annotations || []).map(annotation => [annotation.id, annotation])
  );
  const now = timestampIso();
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
      segments: sortRanges(groupedSegments),
    }))
    .sort((left, right) => left.segments[0].start - right.segments[0].start);
};

export const buildAnnotationText = (content: string, segments: MarkdownRange[]) =>
  normalizeWhitespace(segments.map(segment => content.slice(segment.start, segment.end)).join(' '));

export const sortAnnotationsByDocumentOrder = (
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

export const getRangeOverlapLength = (left: MarkdownRange, right: MarkdownRange) =>
  Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
