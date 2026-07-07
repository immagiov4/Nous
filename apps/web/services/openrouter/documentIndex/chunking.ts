import type { PdfTextChunk, PdfTextIndex, PdfTextPage } from '../../../types.ts';
import { timestampIso } from '../../../utils/time.ts';
import {
  HEADING_MAX_CHARS,
  HEADING_MAX_WORDS,
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  PDF_PLAN_EDGE_EXCLUSION_RATIO,
  PDF_PLAN_MAX_EDGE_PAGES,
  PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION,
  TARGET_CHUNK_CHARS,
} from './constants.ts';
import {
  buildPdfPageTextLayout,
  normalizeWhitespace,
  resolveChunkPageSpanFromLayout,
} from './layout.ts';

const splitParagraphs = (text: string): string[] =>
  normalizeWhitespace(text)
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

const isHeadingCandidate = (paragraph: string): boolean => {
  const compact = paragraph.replace(/\s+/g, ' ').trim();
  if (!compact || compact.length > HEADING_MAX_CHARS) {
    return false;
  }

  const words = compact.split(' ');
  if (words.length > HEADING_MAX_WORDS) {
    return false;
  }

  if (/[.!?;:]$/.test(compact)) {
    return false;
  }

  if (/^\d+(\.\d+)*\s+/.test(compact) || /^[IVXLC]+\.\s+/i.test(compact)) {
    return true;
  }

  const letterCount = compact.replace(/[^A-Za-z]/g, '').length;
  if (letterCount === 0) {
    return false;
  }

  const uppercaseCount = compact.replace(/[^A-Z]/g, '').length;
  if (uppercaseCount / letterCount > 0.7) {
    return true;
  }

  const titleCaseWords = words.filter(word => /^[A-Z][a-z]+/.test(word)).length;
  return titleCaseWords >= Math.max(2, Math.ceil(words.length * 0.6));
};

const inferHeadingLevel = (heading: string): number => {
  const numberingMatch = heading.match(/^(\d+(?:\.\d+)*)\s+/);
  if (numberingMatch) {
    return Math.min(4, numberingMatch[1].split('.').length);
  }

  if (/^[IVXLC]+\.\s+/i.test(heading) || heading === heading.toUpperCase()) {
    return 1;
  }

  return 2;
};

const applyHeadingToPath = (path: string[], heading: string): string[] => {
  const level = inferHeadingLevel(heading);
  const nextPath = path.slice(0, Math.max(0, level - 1));
  nextPath[level - 1] = heading;
  return nextPath.filter(Boolean);
};

const pushSection = (sections: SectionBuffer[], section: SectionBuffer | null) => {
  if (!section || section.paragraphs.length === 0) {
    return;
  }

  sections.push({
    headingPath: [...section.headingPath],
    paragraphs: [...section.paragraphs],
    startOffset: section.startOffset,
    endOffset: section.endOffset,
  });
};

interface SectionBuffer {
  headingPath: string[];
  paragraphs: string[];
  startOffset: number;
  endOffset: number;
}

const buildSections = (text: string): SectionBuffer[] => {
  const paragraphs = splitParagraphs(text);
  const sections: SectionBuffer[] = [];
  let headingPath: string[] = [];
  let offset = 0;
  let current: SectionBuffer | null = null;

  paragraphs.forEach(paragraph => {
    const startOffset = offset;
    offset += paragraph.length + 2;

    if (isHeadingCandidate(paragraph)) {
      pushSection(sections, current);
      headingPath = applyHeadingToPath(headingPath, paragraph);
      current = null;
      return;
    }

    if (!current) {
      current = {
        headingPath: [...headingPath],
        paragraphs: [paragraph],
        startOffset,
        endOffset: startOffset + paragraph.length,
      };
      return;
    }

    current.paragraphs.push(paragraph);
    current.endOffset = startOffset + paragraph.length;
  });

  pushSection(sections, current);
  return sections;
};

const buildChunkText = (paragraphs: string[]): string => paragraphs.join('\n\n').trim();

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const logPdfPlanDebug = (label: string, payload: Record<string, unknown>) => {
  console.groupCollapsed(`[Nous][PDF Plan] ${label}`);
  Object.entries(payload).forEach(([key, value]) => {
    console.info(key, value);
  });
  console.groupEnd();
};

export const formatPageRange = (
  startPage: number | undefined,
  endPage: number | undefined
): string | null => {
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage)) {
    return null;
  }

  return startPage === endPage ? `pag. ${startPage}` : `pag. ${startPage}-${endPage}`;
};

export const expandPageRange = (startPage: number, endPage: number): number[] =>
  Array.from({ length: Math.max(0, endPage - startPage + 1) }, (_, index) => startPage + index);

export const compressPagesToGaps = (pages: number[]): PdfPlanPageGap[] => {
  if (pages.length === 0) {
    return [];
  }

  const sortedPages = [...pages].sort((left, right) => left - right);
  const gaps: PdfPlanPageGap[] = [];
  let rangeStart = sortedPages[0];
  let previousPage = sortedPages[0];

  for (let index = 1; index < sortedPages.length; index += 1) {
    const page = sortedPages[index];
    if (page === previousPage + 1) {
      previousPage = page;
      continue;
    }

    gaps.push({
      startPage: rangeStart,
      endPage: previousPage,
      pageCount: previousPage - rangeStart + 1,
    });
    rangeStart = page;
    previousPage = page;
  }

  gaps.push({
    startPage: rangeStart,
    endPage: previousPage,
    pageCount: previousPage - rangeStart + 1,
  });
  return gaps;
};

interface PdfPlanPageGap {
  endPage: number;
  pageCount: number;
  startPage: number;
}

export const resolvePdfPlanSubstantiveRange = (pageCount: number) => {
  if (pageCount < PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION) {
    return {
      startPage: 1,
      endPage: pageCount,
      pageCount,
    };
  }

  const edgePages = clamp(
    Math.round(pageCount * PDF_PLAN_EDGE_EXCLUSION_RATIO),
    1,
    PDF_PLAN_MAX_EDGE_PAGES
  );
  const startPage = Math.min(pageCount, 1 + edgePages);
  const endPage = Math.max(startPage, pageCount - edgePages);
  return {
    startPage,
    endPage,
    pageCount: endPage - startPage + 1,
  };
};

export const buildCompactSnippet = (text: string, maxChars: number): string => {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const separator = ' ... ';
  const headChars = Math.max(24, Math.floor(maxChars * 0.65));
  const tailChars = Math.max(16, maxChars - headChars - separator.length);
  return `${normalized.slice(0, headChars).trimEnd()}${separator}${normalized.slice(-tailChars).trimStart()}`;
};

const splitLargeSection = (
  section: SectionBuffer
): Array<Omit<PdfTextChunk, 'id' | 'sequence'>> => {
  const chunks: Array<Omit<PdfTextChunk, 'id' | 'sequence'>> = [];
  let currentParagraphs: string[] = [];
  let currentLength = 0;
  let currentStartOffset = section.startOffset;

  section.paragraphs.forEach((paragraph, index) => {
    const addition = paragraph.length + (currentParagraphs.length > 0 ? 2 : 0);
    const shouldFlush =
      currentParagraphs.length > 0 &&
      currentLength >= MIN_CHUNK_CHARS &&
      currentLength + addition > TARGET_CHUNK_CHARS;

    if (shouldFlush) {
      const text = buildChunkText(currentParagraphs);
      chunks.push({
        text,
        headingPath: [...section.headingPath],
        startOffset: currentStartOffset,
        endOffset: currentStartOffset + text.length,
      });

      const overlapParagraph = currentParagraphs[currentParagraphs.length - 1];
      currentParagraphs = overlapParagraph ? [overlapParagraph] : [];
      currentLength = overlapParagraph ? overlapParagraph.length : 0;
      currentStartOffset = Math.max(
        section.startOffset,
        currentStartOffset + text.length - currentLength
      );
    }

    currentParagraphs.push(paragraph);
    currentLength += addition;

    if (currentLength > MAX_CHUNK_CHARS) {
      const text = buildChunkText(currentParagraphs);
      chunks.push({
        text,
        headingPath: [...section.headingPath],
        startOffset: currentStartOffset,
        endOffset: currentStartOffset + text.length,
      });

      currentParagraphs = [];
      currentLength = 0;
      if (index + 1 < section.paragraphs.length) {
        currentStartOffset += text.length;
      }
    }
  });

  if (currentParagraphs.length > 0) {
    const text = buildChunkText(currentParagraphs);
    chunks.push({
      text,
      headingPath: [...section.headingPath],
      startOffset: currentStartOffset,
      endOffset: currentStartOffset + text.length,
    });
  }

  return chunks.filter(chunk => chunk.text.trim().length > 0);
};

export const buildPdfTextIndex = (
  extractedText: string,
  sourceHash?: string,
  documentTitle?: string,
  pages?: PdfTextPage[]
): PdfTextIndex => {
  const pageLayout = buildPdfPageTextLayout(pages);
  const normalized = pageLayout ? pageLayout.text : normalizeWhitespace(extractedText);
  const sections = buildSections(normalized);

  const baseChunks =
    sections.length > 0
      ? sections.flatMap(section => splitLargeSection(section))
      : splitLargeSection({
          headingPath: documentTitle ? [documentTitle] : [],
          paragraphs: splitParagraphs(normalized),
          startOffset: 0,
          endOffset: normalized.length,
        });

  const chunks: PdfTextChunk[] = baseChunks.map((chunk, index) => {
    const pageSpan = resolveChunkPageSpanFromLayout(chunk.startOffset, chunk.endOffset, pageLayout);
    let headingPath = chunk.headingPath;
    if (headingPath.length === 0) {
      headingPath = documentTitle ? [documentTitle] : [];
    }

    return {
      id: `chunk-${String(index + 1).padStart(3, '0')}`,
      sequence: index,
      text: chunk.text,
      headingPath,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      pageStart: pageSpan?.startPage,
      pageEnd: pageSpan?.endPage,
    };
  });

  return {
    kind: 'pdf-text-index',
    parsedAt: timestampIso(),
    sourceHash,
    documentTitle,
    pageCount: pageLayout ? pageLayout.pages.length : undefined,
    chunks,
  };
};
