import type { SectionAnnotation } from '../../types.ts';
import type { MarkdownRange } from '../markdown/codeRanges.ts';

const MARK_CLOSE = '</mark>';
const markOpenWithId = (annotationId: string) => `<mark data-nous-annotation-id="${annotationId}">`;

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

export const wrapRangesWithAnnotation = (
  content: string,
  annotationId: string,
  ranges: MarkdownRange[]
): string => {
  let renderedContent = content;

  sortRanges(ranges)
    .reverse()
    .forEach(range => {
      renderedContent = `${renderedContent.slice(0, range.end)}${MARK_CLOSE}${renderedContent.slice(range.end)}`;
      renderedContent = `${renderedContent.slice(0, range.start)}${markOpenWithId(annotationId)}${renderedContent.slice(range.start)}`;
    });

  return renderedContent;
};

export const sortAnnotationsByDocumentOrder = (
  annotations: SectionAnnotation[]
): SectionAnnotation[] =>
  [...annotations].sort((left, right) => {
    const leftPosition =
      left.anchor?.kind === 'selection' ? left.anchor.selector.start : Number.MAX_SAFE_INTEGER;
    const rightPosition =
      right.anchor?.kind === 'selection' ? right.anchor.selector.start : Number.MAX_SAFE_INTEGER;
    return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt);
  });

export const getRangeOverlapLength = (left: MarkdownRange, right: MarkdownRange) =>
  Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
