import { PDF_TEXT_QUALITY } from './pdfDocumentPolicy';

export interface PdfTextQualityInput {
  extractedText: string;
  pageCount?: number;
  pages: ReadonlyArray<{ text: string }>;
}

export interface PdfTextQualityReport {
  averageCharsPerPage: number;
  extractedCharacterCount: number;
  pageCount: number;
  status: 'low-text' | 'no-text' | 'ok';
  substantivePageCount: number;
  substantivePageRatio: number;
}

const countNormalizedTextChars = (text: string): number =>
  text.replaceAll(/\s+/g, ' ').trim().length;

const resolvePdfTextQualityStatus = ({
  extractedCharacterCount,
  hasEnoughPageCoverage,
  hasEnoughTextDensity,
  hasEnoughTotalText,
}: {
  extractedCharacterCount: number;
  hasEnoughPageCoverage: boolean;
  hasEnoughTextDensity: boolean;
  hasEnoughTotalText: boolean;
}): PdfTextQualityReport['status'] => {
  if (extractedCharacterCount === 0) {
    return 'no-text';
  }
  return hasEnoughTotalText && hasEnoughTextDensity && hasEnoughPageCoverage ? 'ok' : 'low-text';
};

export const assessPdfTextQuality = (input: PdfTextQualityInput): PdfTextQualityReport => {
  const extractedCharacterCount = countNormalizedTextChars(input.extractedText);
  const pageCount = Math.max(input.pageCount || input.pages.length || 1, 1);
  const substantivePageCount = input.pages.filter(
    page => countNormalizedTextChars(page.text) >= PDF_TEXT_QUALITY.SUBSTANTIVE_PAGE_MIN_CHARS
  ).length;
  const substantivePageRatio =
    input.pages.length > 0 ? substantivePageCount / input.pages.length : 0;
  const averageCharsPerPage = extractedCharacterCount / pageCount;
  const minTotalChars =
    pageCount <= PDF_TEXT_QUALITY.SHORT_DOCUMENT_MAX_PAGES
      ? PDF_TEXT_QUALITY.MIN_SHORT_DOCUMENT_CHARS
      : PDF_TEXT_QUALITY.MIN_MULTI_PAGE_DOCUMENT_CHARS;
  const hasEnoughPageCoverage =
    input.pages.length === 0 ||
    pageCount <= PDF_TEXT_QUALITY.SHORT_DOCUMENT_MAX_PAGES ||
    substantivePageRatio >= PDF_TEXT_QUALITY.MIN_TEXT_PAGE_RATIO;

  return {
    averageCharsPerPage: Number.parseFloat(averageCharsPerPage.toFixed(2)),
    extractedCharacterCount,
    pageCount,
    status: resolvePdfTextQualityStatus({
      extractedCharacterCount,
      hasEnoughPageCoverage,
      hasEnoughTextDensity: averageCharsPerPage >= PDF_TEXT_QUALITY.MIN_AVERAGE_CHARS_PER_PAGE,
      hasEnoughTotalText: extractedCharacterCount >= minTotalChars,
    }),
    substantivePageCount,
    substantivePageRatio: Number.parseFloat(substantivePageRatio.toFixed(4)),
  };
};
