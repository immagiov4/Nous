import type { ExtractedPdfTextPage } from './pdfTextExtractor.js';
interface PdfPage {
  readonly view?: number[];
  cleanup(): void;
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
}
export function inspectPdfPageText(page: PdfPage, extractedText: string): Promise<string[]>;
export interface InspectedPdfPages {
  pages: ExtractedPdfTextPage[];
  planned: Array<{ pageNumber: number; reasons: string[] }>;
  pageCount: number;
}

export const PDF_PAGE_LOAD_OPTIONS: import('pdf-parse').LoadParameters;
export function inspectPdfTextPages(
  parser: import('pdf-parse').PDFParse,
  extracted: import('./pdfTextExtractor.js').ExtractedPdfText
): Promise<InspectedPdfPages>;
