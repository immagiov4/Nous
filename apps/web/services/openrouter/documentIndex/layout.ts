import type { PdfTextChunk, PdfTextIndex, PdfTextPage } from '../../../types.ts';
import { normalizeLineEndings } from '../../../utils/text.ts';
import { PAGE_TEXT_SEPARATOR } from './constants.ts';

export const normalizeWhitespace = (text: string): string =>
  normalizeLineEndings(text)
    .replaceAll(/[ \t]+/g, ' ')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

interface PdfPageLayoutEntry extends PdfTextPage {
  startOffset: number;
  endOffset: number;
}

export interface PdfPageTextLayout {
  text: string;
  pages: PdfPageLayoutEntry[];
}

const getPageDistanceFromOffset = (page: PdfPageLayoutEntry, offset: number): number => {
  if (offset < page.startOffset) {
    return page.startOffset - offset;
  }

  if (offset > page.endOffset) {
    return offset - page.endOffset;
  }

  return 0;
};

export const buildPdfPageTextLayout = (
  pages: PdfTextPage[] | null | undefined
): PdfPageTextLayout | null => {
  if (!Array.isArray(pages) || pages.length === 0) {
    return null;
  }

  let combinedText = '';
  const normalizedPages = pages
    .filter(
      (page): page is PdfTextPage =>
        Boolean(page) && Number.isInteger(page.pageNumber) && page.pageNumber > 0
    )
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map(page => {
      const normalizedText = normalizeWhitespace(page.text || '');
      const needsSeparator = combinedText.length > 0 && normalizedText.length > 0;
      if (needsSeparator) {
        combinedText += PAGE_TEXT_SEPARATOR;
      }

      const startOffset = combinedText.length;
      if (normalizedText.length > 0) {
        combinedText += normalizedText;
      }

      return {
        pageNumber: page.pageNumber,
        text: normalizedText,
        startOffset,
        endOffset: combinedText.length,
      };
    });

  return {
    text: combinedText,
    pages: normalizedPages,
  };
};

export const resolveChunkPageSpanFromLayout = (
  startOffset: number,
  endOffset: number,
  pageLayout: PdfPageTextLayout | null | undefined
): { startPage: number; endPage: number } | null => {
  if (!pageLayout || pageLayout.pages.length === 0) {
    return null;
  }

  const pagesWithText = pageLayout.pages.filter(page => page.endOffset > page.startOffset);
  if (pagesWithText.length === 0) {
    return null;
  }

  const normalizedEndOffset = Math.max(startOffset + 1, endOffset);
  const overlappingPages = pagesWithText.filter(
    page => page.startOffset < normalizedEndOffset && page.endOffset > startOffset
  );
  if (overlappingPages.length > 0) {
    return {
      startPage: overlappingPages[0].pageNumber,
      endPage: (overlappingPages.at(-1) as PdfPageLayoutEntry).pageNumber,
    };
  }

  const midpoint = (startOffset + normalizedEndOffset) / 2;
  const closestPageEntry = pagesWithText
    .map(page => ({
      page,
      distance: getPageDistanceFromOffset(page, midpoint),
    }))
    .sort((left, right) => left.distance - right.distance)[0];
  const closestPage = closestPageEntry ? closestPageEntry.page : null;

  return closestPage
    ? {
        startPage: closestPage.pageNumber,
        endPage: closestPage.pageNumber,
      }
    : null;
};

const clampPageNumber = (page: number, pageCount: number): number =>
  Math.min(pageCount, Math.max(1, page));

const getPdfDocumentCharLength = (documentIndex: PdfTextIndex): number =>
  Math.max(
    (documentIndex.chunks.at(-1) || { endOffset: 0 }).endOffset,
    documentIndex.chunks.reduce((maxChars, chunk) => Math.max(maxChars, chunk.endOffset), 0)
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
    return {
      startPage: chunk.pageStart,
      endPage: chunk.pageEnd,
      exact: true,
    };
  }

  const exactSpan = resolveChunkPageSpanFromLayout(chunk.startOffset, chunk.endOffset, pageLayout);
  if (exactSpan) {
    return {
      ...exactSpan,
      exact: true,
    };
  }

  const estimatedSpan = estimatePdfChunkPageSpan(documentIndex, chunk, pageCount);
  if (!estimatedSpan) {
    return null;
  }

  return {
    ...estimatedSpan,
    exact: false,
  };
};
