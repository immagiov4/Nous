import { PDF_PAGE_TEXT_SEPARATOR } from './pdfDocumentPolicy';

export interface PdfTextPage {
  pageNumber: number;
  text: string;
}

export const normalizePdfWhitespace = (text: string): string =>
  text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
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
  if (offset < page.startOffset) return page.startOffset - offset;
  if (offset > page.endOffset) return offset - page.endOffset;
  return 0;
};

export const buildPdfPageTextLayout = (
  pages: readonly PdfTextPage[] | null | undefined
): PdfPageTextLayout | null => {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  let combinedText = '';
  const normalizedPages = [...pages]
    .filter(
      (page): page is PdfTextPage =>
        Boolean(page) && Number.isInteger(page.pageNumber) && page.pageNumber > 0
    )
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map(page => {
      const normalizedText = normalizePdfWhitespace(page.text || '');
      if (combinedText.length > 0 && normalizedText.length > 0) {
        combinedText += PDF_PAGE_TEXT_SEPARATOR;
      }
      const startOffset = combinedText.length;
      if (normalizedText.length > 0) combinedText += normalizedText;
      return {
        pageNumber: page.pageNumber,
        text: normalizedText,
        startOffset,
        endOffset: combinedText.length,
      };
    });
  return { text: combinedText, pages: normalizedPages };
};

export const resolveChunkPageSpanFromLayout = (
  startOffset: number,
  endOffset: number,
  pageLayout: PdfPageTextLayout | null | undefined
): { startPage: number; endPage: number } | null => {
  if (!pageLayout || pageLayout.pages.length === 0) return null;
  const pagesWithText = pageLayout.pages.filter(page => page.endOffset > page.startOffset);
  if (pagesWithText.length === 0) return null;
  const normalizedEndOffset = Math.max(startOffset + 1, endOffset);
  const overlappingPages = pagesWithText.filter(
    page => page.startOffset < normalizedEndOffset && page.endOffset > startOffset
  );
  if (overlappingPages.length > 0) {
    const pageNumbers = overlappingPages.map(page => page.pageNumber);
    return {
      startPage: Math.min(...pageNumbers),
      endPage: Math.max(...pageNumbers),
    };
  }
  const midpoint = (startOffset + normalizedEndOffset) / 2;
  const closestPage = pagesWithText
    .map(page => ({ page, distance: getPageDistanceFromOffset(page, midpoint) }))
    .sort((left, right) => left.distance - right.distance)[0]?.page;
  return closestPage
    ? { startPage: closestPage.pageNumber, endPage: closestPage.pageNumber }
    : null;
};
