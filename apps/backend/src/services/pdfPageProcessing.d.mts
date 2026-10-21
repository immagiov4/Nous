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
