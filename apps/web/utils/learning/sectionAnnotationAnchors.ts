import type { SectionAnnotation, SectionAnnotationTextSelector } from '../../types.ts';
import {
  getMarkdownAnnotationProtectedRanges,
  type MarkdownRange,
  parseMarkdownAnalysis,
} from '../markdown/codeRanges.ts';
import {
  buildContextRegex,
  buildMarkableSegments,
  buildSourceSegments,
  buildVisibleProjection,
  normalizeWhitespace,
  type VisibleProjection,
} from '../markdown/textProjection.ts';
import {
  annotationSegmentsOverlap,
  sortRanges,
  wrapRangesWithAnnotation,
} from './sectionAnnotationMarkup.ts';

const SELECTOR_CONTEXT_LENGTH = 48;

interface AnnotationResolutionContext {
  contextOffset: number;
  contextText: string;
  projection: VisibleProjection;
  protectedRanges: MarkdownRange[];
}

export interface SectionAnnotationBoundaryContext {
  after?: string;
  before?: string;
}

export const buildSectionAnnotationContextText = (
  text: string,
  boundaryContext?: SectionAnnotationBoundaryContext
): { offset: number; text: string } => {
  const before = normalizeWhitespace(boundaryContext?.before ?? '');
  const after = normalizeWhitespace(boundaryContext?.after ?? '');
  return {
    offset: before ? before.length + 1 : 0,
    text: [before, text, after].filter(Boolean).join(' '),
  };
};

const buildAnnotationResolutionContext = (
  content: string,
  boundaryContext?: SectionAnnotationBoundaryContext
): AnnotationResolutionContext => {
  const analysis = parseMarkdownAnalysis(content);
  const projection = buildVisibleProjection(content, analysis);
  const contextualProjection = buildSectionAnnotationContextText(projection.text, boundaryContext);
  return {
    contextOffset: contextualProjection.offset,
    contextText: contextualProjection.text,
    projection,
    protectedRanges: getMarkdownAnnotationProtectedRanges(content, analysis),
  };
};

export const isSelectionAnnotation = (
  annotation: SectionAnnotation
): annotation is SectionAnnotation & {
  anchor: { kind: 'selection'; selector: SectionAnnotationTextSelector };
} => annotation.anchor?.kind === 'selection';

const getProjectionRange = (
  projection: VisibleProjection,
  range: MarkdownRange
): { end: number; start: number; text: string } | null => {
  const includedIndexes = projection.sourceIndexes
    .map((sourceIndex, projectionIndex) => ({
      projectionIndex,
      sourceEnd: projection.sourceEnds[projectionIndex] ?? sourceIndex + 1,
      sourceIndex,
    }))
    .filter(
      ({ sourceEnd, sourceIndex }) =>
        sourceEnd > sourceIndex && sourceIndex < range.end && sourceEnd > range.start
    )
    .map(({ projectionIndex }) => projectionIndex);

  const start = includedIndexes[0];
  const lastIndex = includedIndexes.at(-1);
  if (start === undefined || lastIndex === undefined) {
    return null;
  }

  const end = lastIndex + 1;
  return { end, start, text: projection.text.slice(start, end) };
};

export const createSectionAnnotationSelector = (
  content: string,
  segments: MarkdownRange[]
): SectionAnnotationTextSelector | null => {
  const sortedSegments = sortRanges(segments);
  const firstSegment = sortedSegments[0];
  const lastSegment = sortedSegments.at(-1);
  if (!firstSegment || !lastSegment) {
    return null;
  }

  const sourceRange = { start: firstSegment.start, end: lastSegment.end };
  const projection = buildVisibleProjection(content);
  const projectionRange = getProjectionRange(projection, sourceRange);
  if (!projectionRange) {
    return null;
  }

  return {
    end: sourceRange.end,
    exact: normalizeWhitespace(projectionRange.text),
    prefix: normalizeWhitespace(
      projection.text.slice(
        Math.max(0, projectionRange.start - SELECTOR_CONTEXT_LENGTH),
        projectionRange.start
      )
    ),
    start: sourceRange.start,
    suffix: normalizeWhitespace(
      projection.text.slice(projectionRange.end, projectionRange.end + SELECTOR_CONTEXT_LENGTH)
    ),
  };
};

const buildSegmentsFromProjectionRange = (
  content: string,
  start: number,
  length: number,
  context: AnnotationResolutionContext
): MarkdownRange[] => {
  return buildMarkableSegments(
    content,
    buildSourceSegments(context.projection, start, length),
    context.protectedRanges
  );
};

export const hasSectionAnnotationSelectorContext = (
  selector: SectionAnnotationTextSelector
): boolean =>
  Boolean(normalizeWhitespace(selector.prefix ?? '') || normalizeWhitespace(selector.suffix ?? ''));

export const matchesSectionAnnotationSelectorContext = (
  text: string,
  matchStart: number,
  matchLength: number,
  selector: SectionAnnotationTextSelector
): boolean => {
  const before = normalizeWhitespace(
    text.slice(Math.max(0, matchStart - SELECTOR_CONTEXT_LENGTH - 16), matchStart)
  );
  const after = normalizeWhitespace(
    text.slice(matchStart + matchLength, matchStart + matchLength + SELECTOR_CONTEXT_LENGTH + 16)
  );
  const prefix = normalizeWhitespace(selector.prefix ?? '');
  const suffix = normalizeWhitespace(selector.suffix ?? '');
  const prefixMatches = !prefix || before.endsWith(prefix);
  const suffixMatches = !suffix || after.startsWith(suffix);
  return prefixMatches && suffixMatches;
};

const resolveSectionAnnotationSegmentsWithContext = (
  content: string,
  annotation: SectionAnnotation,
  context: AnnotationResolutionContext
): MarkdownRange[] => {
  if (!isSelectionAnnotation(annotation)) {
    return [];
  }

  const { selector } = annotation.anchor;
  const positionalRange = getProjectionRange(context.projection, selector);
  if (
    positionalRange &&
    normalizeWhitespace(positionalRange.text) === normalizeWhitespace(selector.exact) &&
    matchesSectionAnnotationSelectorContext(
      context.contextText,
      positionalRange.start + context.contextOffset,
      positionalRange.end - positionalRange.start,
      selector
    )
  ) {
    return buildSegmentsFromProjectionRange(
      content,
      positionalRange.start,
      positionalRange.end - positionalRange.start,
      context
    );
  }

  const exactPattern = buildContextRegex(selector.exact);
  if (!exactPattern) {
    return [];
  }

  const matches = [...context.projection.text.matchAll(new RegExp(exactPattern, 'gu'))];
  const contextualMatches = matches.filter(match =>
    matchesSectionAnnotationSelectorContext(
      context.contextText,
      (match.index ?? 0) + context.contextOffset,
      match[0].length,
      selector
    )
  );
  const candidates = hasSectionAnnotationSelectorContext(selector) ? contextualMatches : matches;
  if (candidates.length !== 1) {
    return [];
  }

  const match = candidates[0];
  return buildSegmentsFromProjectionRange(content, match.index ?? 0, match[0].length, context);
};

export const resolveSectionAnnotationSegments = (
  content: string,
  annotation: SectionAnnotation,
  boundaryContext?: SectionAnnotationBoundaryContext
): MarkdownRange[] => {
  if (!isSelectionAnnotation(annotation)) {
    return [];
  }

  return resolveSectionAnnotationSegmentsWithContext(
    content,
    annotation,
    buildAnnotationResolutionContext(content, boundaryContext)
  );
};

export const getSectionAnnotationText = (content: string, annotation: SectionAnnotation): string =>
  isSelectionAnnotation(annotation) &&
  resolveSectionAnnotationSegments(content, annotation).length > 0
    ? annotation.anchor.selector.exact
    : '';

export const materializeSectionAnnotationMarks = (
  content: string,
  annotations?: SectionAnnotation[],
  boundaryContext?: SectionAnnotationBoundaryContext
): string => {
  const acceptedRanges: MarkdownRange[] = [];
  const selectionAnnotations = (annotations || []).filter(isSelectionAnnotation);
  if (selectionAnnotations.length === 0) {
    return content;
  }

  const context = buildAnnotationResolutionContext(content, boundaryContext);
  const resolvedAnnotations = selectionAnnotations
    .map(annotation => ({
      annotation,
      segments: resolveSectionAnnotationSegmentsWithContext(content, annotation, context),
    }))
    .filter(candidate => candidate.segments.length > 0)
    .sort((left, right) => left.segments[0].start - right.segments[0].start)
    .filter(candidate => {
      if (
        candidate.segments.some(segment =>
          acceptedRanges.some(acceptedRange => annotationSegmentsOverlap(segment, acceptedRange))
        )
      ) {
        return false;
      }

      acceptedRanges.push(...candidate.segments);
      return true;
    });

  return resolvedAnnotations
    .sort((left, right) => right.segments[0].start - left.segments[0].start)
    .reduce(
      (renderedContent, candidate) =>
        wrapRangesWithAnnotation(renderedContent, candidate.annotation.id, candidate.segments),
      content
    );
};
