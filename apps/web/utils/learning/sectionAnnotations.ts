import type { SectionAnnotation, SectionAnnotationArtifactRef } from '../../types.ts';
import { createEntityId } from '../ids.ts';
import { timestampIso } from '../time.ts';
import {
  annotationSegmentsOverlap,
  buildAnnotationText,
  buildGroupsById,
  getRangeOverlapLength,
  groupLegacySegmentsByContent,
  MARK_OPEN_WITH_ID,
  mergeRanges,
  parseMarkSegments,
  remapRangesAfterRemoving,
  removeRangesFromContent,
  sortAnnotationsByDocumentOrder,
  sortRanges,
  wrapRangesWithAnnotation,
} from './sectionAnnotationMarkup.ts';
import { normalizeWhitespace, resolveSelectedSegments } from './sectionAnnotationProjection.ts';

export const NOTE_MERGE_SEPARATOR = '\n\n---\n\n';

interface ApplySectionAnnotationOptions {
  annotations?: SectionAnnotation[];
  artifactRefs?: SectionAnnotationArtifactRef[];
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

interface CreateLessonSectionAnnotationResult {
  annotationId: string;
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

const mergeAnnotationArtifactRefs = (
  existingRefs: SectionAnnotationArtifactRef[] | undefined,
  addedRefs: SectionAnnotationArtifactRef[] | undefined
): SectionAnnotationArtifactRef[] | undefined => {
  const refsById = new Map<string, SectionAnnotationArtifactRef>();

  (existingRefs || []).forEach(ref => {
    refsById.set(ref.artifactId, ref);
  });
  (addedRefs || []).forEach(ref => {
    if (!refsById.has(ref.artifactId)) {
      refsById.set(ref.artifactId, ref);
    }
  });

  return refsById.size > 0 ? Array.from(refsById.values()) : undefined;
};

export const getSectionAnnotationText = (content: string, annotationId: string): string => {
  const groups = buildGroupsById(undefined, parseMarkSegments(content));
  const group = groups.find(candidate => candidate.annotation.id === annotationId);
  if (!group) {
    return '';
  }

  return buildAnnotationText(content, group.segments);
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
  artifactRefs,
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
  const mergedArtifactRefs = mergeAnnotationArtifactRefs(undefined, [
    ...(artifactRefs || []),
    ...absorbedGroups.flatMap(group => group.annotation.artifactRefs || []),
  ]);
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
      ...(mergedArtifactRefs ? { artifactRefs: mergedArtifactRefs } : {}),
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

export const createLessonSectionAnnotation = ({
  annotations,
  artifactRefs,
  createId = createAnnotationId,
  note = '',
  now = timestampIso(),
}: {
  annotations?: SectionAnnotation[];
  artifactRefs?: SectionAnnotationArtifactRef[];
  createId?: () => string;
  note?: string;
  now?: string;
}): CreateLessonSectionAnnotationResult => {
  const annotationId = createId();
  const mergedArtifactRefs = mergeAnnotationArtifactRefs(undefined, artifactRefs);
  const nextAnnotation: SectionAnnotation = {
    anchor: { kind: 'lesson' },
    ...(mergedArtifactRefs ? { artifactRefs: mergedArtifactRefs } : {}),
    createdAt: now,
    id: annotationId,
    note: note.trim(),
    updatedAt: now,
  };

  return {
    annotationId,
    annotations: [...(annotations || []), nextAnnotation].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    ),
  };
};

export const upsertSectionAnnotationArtifactRefs = ({
  annotationId,
  annotations,
  artifactRefs,
  now = timestampIso(),
}: {
  annotationId: string;
  annotations?: SectionAnnotation[];
  artifactRefs: SectionAnnotationArtifactRef[];
  now?: string;
}): UpdateSectionAnnotationNoteResult | null => {
  const existingAnnotation = (annotations || []).find(annotation => annotation.id === annotationId);
  if (!existingAnnotation) {
    return null;
  }

  const nextAnnotation = {
    ...existingAnnotation,
    artifactRefs: mergeAnnotationArtifactRefs(existingAnnotation.artifactRefs, artifactRefs),
    updatedAt: now,
  };

  return {
    annotation: nextAnnotation,
    annotations: (annotations || []).map(annotation =>
      annotation.id === annotationId ? nextAnnotation : annotation
    ),
  };
};

export const removeSectionAnnotationArtifactRef = ({
  annotationId,
  annotations,
  artifactId,
  now = timestampIso(),
}: {
  annotationId: string;
  annotations?: SectionAnnotation[];
  artifactId: string;
  now?: string;
}): UpdateSectionAnnotationNoteResult | null => {
  const existingAnnotation = (annotations || []).find(annotation => annotation.id === annotationId);
  if (!existingAnnotation) {
    return null;
  }

  const nextArtifactRefs = (existingAnnotation.artifactRefs || []).filter(
    ref => ref.artifactId !== artifactId
  );
  const { artifactRefs: _removedArtifactRefs, ...annotationWithoutArtifactRefs } =
    existingAnnotation;
  const nextAnnotation: SectionAnnotation =
    nextArtifactRefs.length > 0
      ? { ...existingAnnotation, artifactRefs: nextArtifactRefs, updatedAt: now }
      : { ...annotationWithoutArtifactRefs, updatedAt: now };

  return {
    annotation: nextAnnotation,
    annotations: (annotations || []).map(annotation =>
      annotation.id === annotationId ? nextAnnotation : annotation
    ),
  };
};

export const updateSectionAnnotationNote = ({
  annotationId,
  annotations,
  artifactRefs,
  note,
  now = timestampIso(),
}: {
  annotationId: string;
  annotations?: SectionAnnotation[];
  artifactRefs?: SectionAnnotationArtifactRef[];
  note: string;
  now?: string;
}): UpdateSectionAnnotationNoteResult | null => {
  const existingAnnotation = (annotations || []).find(annotation => annotation.id === annotationId);
  if (!existingAnnotation) {
    return null;
  }

  const mergedArtifactRefs = mergeAnnotationArtifactRefs(
    existingAnnotation.artifactRefs,
    artifactRefs
  );
  const nextAnnotation = {
    ...existingAnnotation,
    ...(mergedArtifactRefs ? { artifactRefs: mergedArtifactRefs } : {}),
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
