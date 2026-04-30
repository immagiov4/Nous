import type { SectionAnnotation } from '../../types.ts';
import { createEntityId } from '../ids.ts';
import { getMarkdownProtectedRanges, type MarkdownRange } from '../markdown/codeRanges.ts';
import { timestampIso } from '../time.ts';
import { normalizeWhitespace, resolveSelectedSegments } from './sectionAnnotationProjection.ts';

const MARK_CLOSE = '</mark>';
const MARK_OPEN_WITH_ID = (annotationId: string) =>
  `<mark data-nous-annotation-id="${annotationId}">`;
const MARK_OPEN_TAG_REGEX = /^<mark\b[^>]*>/iu;
const ANNOTATION_ID_REGEX = /\bdata-(?:nous|lumina)-annotation-id=(["'])([^"']+)\1/iu;
const LEGACY_GROUP_GAP_TOKENS_REGEX =
  /(?:\s+|[*_~`]+|(?:^|\n)\s{0,3}(?:#{1,6}|>|-|\*|\+|\d+\.)\s*)/gu;

export const NOTE_MERGE_SEPARATOR = '\n\n---\n\n';

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

const createAnnotationId = () =>
  createEntityId({ fallbackPrefix: 'annotation', uuidPrefix: 'annotation' });

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
  now = timestampIso(),
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
  now = timestampIso(),
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
  now = timestampIso(),
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
