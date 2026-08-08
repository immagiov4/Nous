import {
  PDF_PLAN_EDGE_EXCLUSION_RATIO,
  PDF_PLAN_MAX_EDGE_PAGES,
  PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION,
  PDF_TEXT_CHUNK_MAX_CHARS,
  PDF_TEXT_CHUNK_MIN_CHARS,
  PDF_TEXT_CHUNK_TARGET_CHARS,
} from './pdfDocumentPolicy';
import {
  buildPdfPageTextLayout,
  normalizePdfWhitespace,
  type PdfPageTextLayout,
  type PdfTextPage,
  resolveChunkPageSpanFromLayout,
} from './pdfTextLayout';

export type { PdfTextPage } from './pdfTextLayout';

export interface PdfTextChunk {
  endOffset: number;
  headingPath: string[];
  id: string;
  pageEnd?: number;
  pageStart?: number;
  sequence: number;
  sourceId?: string;
  startOffset: number;
  text: string;
}

export interface PdfTextIndex {
  chunks: PdfTextChunk[];
  documentTitle?: string;
  kind: 'pdf-text-index';
  pageCount?: number;
  parsedAt: string;
  sourceHash?: string;
  sourceIds?: string[];
}

interface SectionBuffer {
  headingPath: string[];
  paragraphs: string[];
  startOffset: number;
  endOffset: number;
}

const HEADING_MAX_WORDS = 14;
const HEADING_MAX_CHARS = 120;

const splitParagraphs = (text: string): string[] =>
  normalizePdfWhitespace(text)
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

const isHeadingCandidate = (paragraph: string): boolean => {
  const compact = paragraph.replaceAll(/\s+/g, ' ').trim();
  if (!compact || compact.length > HEADING_MAX_CHARS) return false;
  const words = compact.split(' ');
  if (words.length > HEADING_MAX_WORDS || /[.!?;:]$/.test(compact)) return false;
  if (/^\d+(\.\d+)*\s+/.test(compact) || /^[IVXLC]+\.\s+/i.test(compact)) return true;
  const letterCount = compact.replaceAll(/[^A-Za-z]/g, '').length;
  if (letterCount === 0) return false;
  const uppercaseCount = compact.replaceAll(/[^A-Z]/g, '').length;
  if (uppercaseCount / letterCount > 0.7) return true;
  const titleCaseWords = words.filter(word => /^[A-Z][a-z]+/.test(word)).length;
  return titleCaseWords >= Math.max(2, Math.ceil(words.length * 0.6));
};

const inferHeadingLevel = (heading: string): number => {
  const numberingMatch = /^(\d+(?:\.\d+)*)\s+/.exec(heading);
  if (numberingMatch) return Math.min(4, numberingMatch[1].split('.').length);
  if (/^[IVXLC]+\.\s+/i.test(heading) || heading === heading.toUpperCase()) return 1;
  return 2;
};

const applyHeadingToPath = (path: string[], heading: string): string[] => {
  const level = inferHeadingLevel(heading);
  const nextPath = path.slice(0, Math.max(0, level - 1));
  nextPath[level - 1] = heading;
  return nextPath.filter(Boolean);
};

const pushSection = (sections: SectionBuffer[], section: SectionBuffer | null): void => {
  if (!section || section.paragraphs.length === 0) return;
  sections.push({
    headingPath: [...section.headingPath],
    paragraphs: [...section.paragraphs],
    startOffset: section.startOffset,
    endOffset: section.endOffset,
  });
};

const buildSections = (text: string): SectionBuffer[] => {
  const paragraphs = splitParagraphs(text);
  const sections: SectionBuffer[] = [];
  let headingPath: string[] = [];
  let offset = 0;
  let current: SectionBuffer | null = null;
  for (const paragraph of paragraphs) {
    const startOffset = offset;
    offset += paragraph.length + 2;
    if (isHeadingCandidate(paragraph)) {
      pushSection(sections, current);
      headingPath = applyHeadingToPath(headingPath, paragraph);
      current = null;
      continue;
    }
    if (!current) {
      current = {
        headingPath: [...headingPath],
        paragraphs: [paragraph],
        startOffset,
        endOffset: startOffset + paragraph.length,
      };
      continue;
    }
    current.paragraphs.push(paragraph);
    current.endOffset = startOffset + paragraph.length;
  }
  pushSection(sections, current);
  return sections;
};

const buildChunkText = (paragraphs: string[]): string => paragraphs.join('\n\n').trim();

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const expandPageRange = (startPage: number, endPage: number): number[] =>
  Array.from({ length: Math.max(0, endPage - startPage + 1) }, (_, index) => startPage + index);

const clampPageNumber = (page: number, pageCount: number): number =>
  Math.min(pageCount, Math.max(1, page));

const getPdfDocumentCharLength = (documentIndex: PdfTextIndex): number =>
  Math.max(
    (documentIndex.chunks.at(-1) || { endOffset: 0 }).endOffset,
    documentIndex.chunks.reduce((maximum, chunk) => Math.max(maximum, chunk.endOffset), 0)
  );

const estimatePdfChunkPageSpan = (
  documentIndex: PdfTextIndex | null | undefined,
  chunk: PdfTextChunk,
  pageCount: number | undefined
): { startPage: number; endPage: number } | null => {
  if (!documentIndex || documentIndex.chunks.length === 0 || !pageCount || pageCount < 1) {
    return null;
  }
  const totalDocumentChars = getPdfDocumentCharLength(documentIndex);
  const chunkCount = Math.max(1, documentIndex.chunks.length);
  const hasDocumentCharLength = totalDocumentChars > 0;
  const startProgress = hasDocumentCharLength
    ? chunk.startOffset / totalDocumentChars
    : chunk.sequence / chunkCount;
  const endProgress = hasDocumentCharLength
    ? Math.max(chunk.startOffset, chunk.endOffset - 1) / totalDocumentChars
    : (chunk.sequence + 1) / chunkCount;
  const startPage = clampPageNumber(Math.floor(startProgress * pageCount) + 1, pageCount);
  const endPage = clampPageNumber(Math.ceil(endProgress * pageCount), pageCount);
  return {
    startPage: Math.min(startPage, endPage),
    endPage: Math.max(startPage, endPage),
  };
};

export const resolvePdfChunkPageSpan = (
  documentIndex: PdfTextIndex | null | undefined,
  chunk: PdfTextChunk,
  pageCount: number | undefined,
  pageLayout?: PdfPageTextLayout | null
): { startPage: number; endPage: number; exact: boolean } | null => {
  if (typeof chunk.pageStart === 'number' && typeof chunk.pageEnd === 'number') {
    return { startPage: chunk.pageStart, endPage: chunk.pageEnd, exact: true };
  }
  const exactSpan = resolveChunkPageSpanFromLayout(chunk.startOffset, chunk.endOffset, pageLayout);
  if (exactSpan) return { ...exactSpan, exact: true };
  const estimatedSpan = estimatePdfChunkPageSpan(documentIndex, chunk, pageCount);
  return estimatedSpan ? { ...estimatedSpan, exact: false } : null;
};

export interface PdfPlanPageGap {
  endPage: number;
  pageCount: number;
  startPage: number;
}

export const compressPagesToGaps = (pages: number[]): PdfPlanPageGap[] => {
  if (pages.length === 0) return [];
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

export const resolvePdfPlanSubstantiveRange = (pageCount: number) => {
  if (pageCount < PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION) {
    return { startPage: 1, endPage: pageCount, pageCount };
  }
  const edgePages = clamp(
    Math.round(pageCount * PDF_PLAN_EDGE_EXCLUSION_RATIO),
    1,
    PDF_PLAN_MAX_EDGE_PAGES
  );
  const startPage = Math.min(pageCount, 1 + edgePages);
  const endPage = Math.max(startPage, pageCount - edgePages);
  return { startPage, endPage, pageCount: endPage - startPage + 1 };
};

export const buildCompactSnippet = (text: string, maxChars: number): string => {
  const normalized = normalizePdfWhitespace(text);
  if (normalized.length <= maxChars) return normalized;
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
      currentLength >= PDF_TEXT_CHUNK_MIN_CHARS &&
      currentLength + addition > PDF_TEXT_CHUNK_TARGET_CHARS;
    if (shouldFlush) {
      const text = buildChunkText(currentParagraphs);
      chunks.push({
        text,
        headingPath: [...section.headingPath],
        startOffset: currentStartOffset,
        endOffset: currentStartOffset + text.length,
      });
      const overlapParagraph = currentParagraphs.at(-1);
      currentParagraphs = overlapParagraph ? [overlapParagraph] : [];
      currentLength = overlapParagraph ? overlapParagraph.length : 0;
      currentStartOffset = Math.max(
        section.startOffset,
        currentStartOffset + text.length - currentLength
      );
    }
    currentParagraphs.push(paragraph);
    currentLength += addition;
    if (currentLength > PDF_TEXT_CHUNK_MAX_CHARS) {
      const text = buildChunkText(currentParagraphs);
      chunks.push({
        text,
        headingPath: [...section.headingPath],
        startOffset: currentStartOffset,
        endOffset: currentStartOffset + text.length,
      });
      currentParagraphs = [];
      currentLength = 0;
      if (index + 1 < section.paragraphs.length) currentStartOffset += text.length;
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
  pages?: readonly PdfTextPage[],
  sourceId?: string,
  now: () => string = () => new Date().toISOString()
): PdfTextIndex => {
  const pageLayout = buildPdfPageTextLayout(pages);
  const normalized = pageLayout ? pageLayout.text : normalizePdfWhitespace(extractedText);
  const sections = buildSections(normalized);
  const fallbackHeadingPath = documentTitle ? [documentTitle] : [];
  const baseChunks =
    sections.length > 0
      ? sections.flatMap(section => splitLargeSection(section))
      : splitLargeSection({
          headingPath: fallbackHeadingPath,
          paragraphs: splitParagraphs(normalized),
          startOffset: 0,
          endOffset: normalized.length,
        });
  const chunks = baseChunks.map((chunk, index): PdfTextChunk => {
    const pageSpan = resolveChunkPageSpanFromLayout(chunk.startOffset, chunk.endOffset, pageLayout);
    const sourcePrefix = sourceId ? `${sourceId}:` : '';
    return {
      id: `${sourcePrefix}chunk-${String(index + 1).padStart(3, '0')}`,
      sourceId,
      sequence: index,
      text: chunk.text,
      headingPath: chunk.headingPath.length > 0 ? chunk.headingPath : fallbackHeadingPath,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      pageStart: pageSpan?.startPage,
      pageEnd: pageSpan?.endPage,
    };
  });
  return {
    kind: 'pdf-text-index',
    parsedAt: now(),
    sourceHash,
    sourceIds: sourceId ? [sourceId] : undefined,
    documentTitle,
    pageCount: pageLayout ? pageLayout.pages.length : undefined,
    chunks,
  };
};
