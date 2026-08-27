import type { SectionAnnotation, SectionAnnotationArtifactRef } from '../../types.ts';
import { createEntityId } from '../ids.ts';
import { timestampIso } from '../time.ts';
import {
  createSectionAnnotationSelector,
  getSectionAnnotationText as getAnchoredAnnotationText,
  resolveSectionAnnotationSegmentEntries,
} from './sectionAnnotationAnchors.ts';
import {
  annotationSegmentsOverlap,
  getRangeOverlapLength,
  mergeRanges,
  sortAnnotationsByDocumentOrder,
} from './sectionAnnotationMarkup.ts';
import {
  normalizeWhitespace,
  type PreferredAnnotationSelection,
  resolveSelectedSegments,
} from './sectionAnnotationProjection.ts';

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
  preferredSelection?: PreferredAnnotationSelection;
  selectedText: string;
  selectedTextStart?: number;
}

interface ApplySectionAnnotationResult {
  annotationId: string;
  annotations: SectionAnnotation[];
  merged: boolean;
  resolvedText: string;
}

interface RemoveSectionAnnotationResult {
  annotations: SectionAnnotation[];
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

export const getSectionAnnotationText = (
  content: string,
  annotationId: string,
  annotations?: SectionAnnotation[]
): string => {
  const annotation = (annotations || []).find(candidate => candidate.id === annotationId);
  return annotation ? getAnchoredAnnotationText(content, annotation) : '';
};

export const findSectionAnnotationForSelection = ({
  annotations,
  content,
  contextAfter,
  contextBefore,
  preferredSelection,
  selectedText,
  selectedTextStart,
}: Pick<
  ApplySectionAnnotationOptions,
  | 'annotations'
  | 'content'
  | 'contextAfter'
  | 'contextBefore'
  | 'preferredSelection'
  | 'selectedText'
  | 'selectedTextStart'
>): FindSectionAnnotationForSelectionResult | null => {
  const selectedSegments = resolveSelectedSegments({
    content,
    contextAfter,
    contextBefore,
    preferredSelection,
    selectedText,
    selectedTextStart,
  });
  if (selectedSegments.length === 0) {
    return null;
  }

  const normalizedSelectedText = normalizeWhitespace(selectedText);
  const matches = resolveSectionAnnotationSegmentEntries(content, annotations || [])
    .map(({ annotation, segments }) => ({
      annotation,
      resolvedText: annotation.anchor.selector.exact,
      segments,
    }))
    .map(candidate => ({
      ...candidate,
      overlapLength: candidate.segments.reduce(
        (totalOverlap, annotationSegment) =>
          totalOverlap +
          selectedSegments.reduce(
            (segmentOverlap, selectedSegment) =>
              segmentOverlap + getRangeOverlapLength(annotationSegment, selectedSegment),
            0
          ),
        0
      ),
    }))
    .filter(candidate => candidate.overlapLength > 0)
    .sort((left, right) => {
      const leftText = normalizeWhitespace(left.resolvedText);
      const rightText = normalizeWhitespace(right.resolvedText);
      const leftExact = leftText === normalizedSelectedText;
      const rightExact = rightText === normalizedSelectedText;
      if (leftExact !== rightExact) {
        return rightExact ? 1 : -1;
      }

      const leftContains =
        leftText.includes(normalizedSelectedText) || normalizedSelectedText.includes(leftText);
      const rightContains =
        rightText.includes(normalizedSelectedText) || normalizedSelectedText.includes(rightText);
      if (leftContains !== rightContains) {
        return rightContains ? 1 : -1;
      }

      return (
        right.overlapLength - left.overlapLength || left.segments[0].start - right.segments[0].start
      );
    });

  const bestMatch = matches[0];
  return bestMatch
    ? { annotation: bestMatch.annotation, resolvedText: bestMatch.resolvedText }
    : null;
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
  preferredSelection,
  selectedText,
  selectedTextStart,
}: ApplySectionAnnotationOptions): ApplySectionAnnotationResult | null => {
  const selectedSegments = resolveSelectedSegments({
    content,
    contextAfter,
    contextBefore,
    preferredSelection,
    selectedText,
    selectedTextStart,
  });
  if (selectedSegments.length === 0) {
    return null;
  }

  const anchoredAnnotations = resolveSectionAnnotationSegmentEntries(
    content,
    annotations || []
  ).filter(candidate => candidate.segments.length > 0);
  const absorbedAnnotations = anchoredAnnotations.filter(candidate =>
    candidate.segments.some(existingSegment =>
      selectedSegments.some(selectedSegment =>
        annotationSegmentsOverlap(existingSegment, selectedSegment)
      )
    )
  );
  const selector = createSectionAnnotationSelector(
    content,
    mergeRanges([
      ...selectedSegments,
      ...absorbedAnnotations.flatMap(candidate => candidate.segments),
    ])
  );
  if (!selector) {
    return null;
  }

  const absorbedIds = new Set(absorbedAnnotations.map(candidate => candidate.annotation.id));
  const absorbedMetadata = absorbedAnnotations
    .sort((left, right) => left.segments[0].start - right.segments[0].start)
    .map(candidate => candidate.annotation);
  const annotationId = preferredAnnotationId || absorbedMetadata[0]?.id || createId();
  const mergedNote = [note.trim(), ...absorbedMetadata.map(annotation => annotation.note.trim())]
    .filter(Boolean)
    .join(NOTE_MERGE_SEPARATOR);
  const mergedArtifactRefs = mergeAnnotationArtifactRefs(undefined, [
    ...(artifactRefs || []),
    ...absorbedMetadata.flatMap(annotation => annotation.artifactRefs || []),
  ]);
  const createdAt =
    absorbedMetadata
      .map(annotation => annotation.createdAt)
      .sort((left, right) => left.localeCompare(right))[0] || now;
  const retainedAnnotations = (annotations || []).filter(
    annotation => !absorbedIds.has(annotation.id) && annotation.id !== annotationId
  );

  return {
    annotationId,
    annotations: sortAnnotationsByDocumentOrder([
      ...retainedAnnotations,
      {
        anchor: { kind: 'selection', selector },
        ...(mergedArtifactRefs ? { artifactRefs: mergedArtifactRefs } : {}),
        createdAt,
        id: annotationId,
        note: mergedNote,
        updatedAt: now,
      },
    ]),
    merged: absorbedAnnotations.length > 0,
    resolvedText: selector.exact,
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
}: {
  annotationId: string;
  annotations?: SectionAnnotation[];
}): RemoveSectionAnnotationResult => {
  const removed = (annotations || []).some(annotation => annotation.id === annotationId);
  return {
    annotations: removed
      ? (annotations || []).filter(annotation => annotation.id !== annotationId)
      : annotations || [],
    removed,
  };
};
