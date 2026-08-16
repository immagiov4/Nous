export class PdfTextWorkerOutputLimitError extends Error {}

export interface BoundedPdfTextWorkerPayload {
  outline: unknown;
  pages: Array<{ pageNumber: number; text: string }>;
  text?: string;
}

export function buildBoundedPdfTextWorkerPayload(input: {
  fallbackText: string;
  maxOutputBytes?: number;
  outline: unknown;
  pages: Array<{ num: number; text: string }>;
}): BoundedPdfTextWorkerPayload;
