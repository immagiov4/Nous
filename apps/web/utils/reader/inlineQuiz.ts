import type { QuizQuestion } from '../../types.ts';
import { getMarkdownProtectedRanges, type MarkdownRange } from '../markdown/codeRanges.ts';

export interface InlineQuizChunk {
  markdown: string;
  questionIndexes: number[];
}

export const INLINE_QUIZ_MARKER_FORMAT = '{{INLINE_QUIZ:n}}';
const INLINE_QUIZ_RESERVED_OPENING = '{{INLINE_QUIZ';
const QUIZ_MARKER_REGEX = /\{\{INLINE_QUIZ:(\d+)}}/g;

interface StructuralInlineQuizMarker {
  end: number;
  questionIndex: number;
  start: number;
  text: string;
}

interface InlineQuizSyntax {
  hasMalformedReservedOpening: boolean;
  hasUnprotectedReservedOpening: boolean;
  markers: StructuralInlineQuizMarker[];
}

export const buildInlineQuizMarker = (questionIndex: number): string =>
  `{{INLINE_QUIZ:${questionIndex}}}`;

const overlapsProtectedRange = (
  start: number,
  end: number,
  protectedRanges: MarkdownRange[]
): boolean => protectedRanges.some(range => range.start < end && range.end > start);

const isStandaloneMarkerLine = (content: string, start: number, end: number): boolean => {
  const lineStart = content.lastIndexOf('\n', start - 1) + 1;
  const nextLineBreak = content.indexOf('\n', end);
  const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
  return content.slice(lineStart, lineEnd).trim() === content.slice(start, end);
};

const inspectInlineQuizSyntax = (content: string): InlineQuizSyntax => {
  const protectedRanges = getMarkdownProtectedRanges(content);
  const markers = Array.from(content.matchAll(QUIZ_MARKER_REGEX))
    .map(match => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (
        overlapsProtectedRange(start, end, protectedRanges) ||
        !isStandaloneMarkerLine(content, start, end)
      ) {
        return null;
      }

      return {
        end,
        questionIndex: Number.parseInt(match[1] || '', 10),
        start,
        text: match[0],
      };
    })
    .filter((marker): marker is StructuralInlineQuizMarker => marker !== null);
  const structuralMarkerStarts = new Set(markers.map(marker => marker.start));
  const unprotectedReservedOpenings: number[] = [];
  let openingIndex = content.indexOf(INLINE_QUIZ_RESERVED_OPENING);

  while (openingIndex >= 0) {
    const openingEnd = openingIndex + INLINE_QUIZ_RESERVED_OPENING.length;
    if (!overlapsProtectedRange(openingIndex, openingEnd, protectedRanges)) {
      unprotectedReservedOpenings.push(openingIndex);
    }
    openingIndex = content.indexOf(INLINE_QUIZ_RESERVED_OPENING, openingEnd);
  }

  return {
    hasMalformedReservedOpening: unprotectedReservedOpenings.some(
      start => !structuralMarkerStarts.has(start)
    ),
    hasUnprotectedReservedOpening: unprotectedReservedOpenings.length > 0,
    markers,
  };
};

export const stripInlineQuizMarkers = (content: string): string =>
  inspectInlineQuizSyntax(content).markers.reduceRight(
    (currentContent, marker) =>
      `${currentContent.slice(0, marker.start)}${currentContent.slice(marker.end)}`,
    content
  );

const findParagraphEndOffset = (content: string, excerptEndOffset: number): number => {
  const paragraphBreakOffset = content.indexOf('\n\n', excerptEndOffset);
  return paragraphBreakOffset >= 0 ? paragraphBreakOffset : content.length;
};

const buildLegacyAnchoredQuizLayout = (
  content: string,
  questions: QuizQuestion[]
): InlineQuizChunk[] | null => {
  const placements = questions.map((question, questionIndex) => {
    const excerpt = question.anchorExcerpt?.trim();
    const excerptOffset = excerpt ? content.indexOf(excerpt) : -1;
    if (!excerpt || excerptOffset < 0 || excerptOffset !== content.lastIndexOf(excerpt)) {
      return null;
    }

    return {
      offset: findParagraphEndOffset(content, excerptOffset + excerpt.length),
      questionIndex,
    };
  });
  const validPlacements = placements.filter(
    (placement): placement is NonNullable<typeof placement> => placement !== null
  );
  if (validPlacements.length !== placements.length) {
    return null;
  }

  const questionIndexesByOffset = new Map<number, number[]>();
  for (const placement of validPlacements) {
    const questionIndexes = questionIndexesByOffset.get(placement.offset) ?? [];
    questionIndexes.push(placement.questionIndex);
    questionIndexesByOffset.set(placement.offset, questionIndexes);
  }

  const chunks: InlineQuizChunk[] = [];
  let lastOffset = 0;
  for (const [offset, questionIndexes] of [...questionIndexesByOffset].sort(
    ([leftOffset], [rightOffset]) => leftOffset - rightOffset
  )) {
    const markdown = content.slice(lastOffset, offset).trim();
    if (!markdown) return null;
    chunks.push({ markdown, questionIndexes });
    lastOffset = offset;
  }

  const trailingMarkdown = content.slice(lastOffset).trim();
  if (trailingMarkdown) {
    chunks.push({ markdown: trailingMarkdown, questionIndexes: [] });
  }
  return chunks;
};

const buildLegacyUnanchoredQuizLayout = (
  content: string,
  questions: QuizQuestion[]
): InlineQuizChunk[] => {
  const markdown = content.trim();
  return markdown
    ? [{ markdown, questionIndexes: questions.map((_, questionIndex) => questionIndex) }]
    : [];
};

const syntaxMatchesInlineQuizMarkerContract = (
  content: string,
  questionCount: number,
  syntax: InlineQuizSyntax
): boolean => {
  return (
    !syntax.hasMalformedReservedOpening &&
    syntax.markers.length === questionCount &&
    syntax.markers.every((marker, markerIndex) => {
      const previousMarkerEnd = markerIndex === 0 ? 0 : (syntax.markers[markerIndex - 1]?.end ?? 0);
      return (
        marker.questionIndex === markerIndex &&
        content.slice(previousMarkerEnd, marker.start).trim().length > 0
      );
    })
  );
};

export const hasExactInlineQuizMarkerContract = (content: string, questionCount: number): boolean =>
  syntaxMatchesInlineQuizMarkerContract(content, questionCount, inspectInlineQuizSyntax(content));

export const buildInlineQuizLayout = (
  content: string,
  questions: QuizQuestion[]
): InlineQuizChunk[] => {
  const syntax = inspectInlineQuizSyntax(content);
  if (!syntaxMatchesInlineQuizMarkerContract(content, questions.length, syntax)) {
    if (!syntax.hasUnprotectedReservedOpening) {
      return (
        buildLegacyAnchoredQuizLayout(content, questions) ??
        buildLegacyUnanchoredQuizLayout(content, questions)
      );
    }

    throw new Error(
      `Invalid inline quiz marker contract: expected ${questions.length} ordered marker(s) in ${INLINE_QUIZ_MARKER_FORMAT} format.`
    );
  }

  const chunks: InlineQuizChunk[] = [];
  let lastIndex = 0;

  for (const marker of syntax.markers) {
    const markdown = content.slice(lastIndex, marker.start).trim();
    if (!markdown) {
      throw new Error(
        'Invalid inline quiz marker contract: every marker needs preceding lesson text.'
      );
    }

    chunks.push({ markdown, questionIndexes: [] });
    chunks.at(-1)?.questionIndexes.push(marker.questionIndex);
    lastIndex = marker.end;
  }

  const trailingMarkdown = content.slice(lastIndex).trim();
  if (trailingMarkdown) {
    chunks.push({ markdown: trailingMarkdown, questionIndexes: [] });
  }
  return chunks;
};
