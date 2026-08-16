export class PdfTextWorkerOutputLimitError extends Error {
  constructor() {
    super('PDF fallback output exceeds the configured limit.');
    this.name = 'PdfTextWorkerOutputLimitError';
  }
}

interface PdfTextWorkerPage {
  num: number;
  text: string;
}

interface BoundedPdfTextWorkerPayload {
  outline: unknown;
  pages: Array<{ pageNumber: number; text: string }>;
  text?: string;
}

export const buildBoundedPdfTextWorkerPayload = ({
  fallbackText,
  maxOutputBytes,
  outline,
  pages,
}: {
  fallbackText: string;
  maxOutputBytes?: number;
  outline: unknown;
  pages: PdfTextWorkerPage[];
}): BoundedPdfTextWorkerPayload => {
  let outputBytes = 0;
  const addOutputBytes = (value: string) => {
    outputBytes += Buffer.byteLength(value, 'utf8');
    if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
      throw new PdfTextWorkerOutputLimitError();
    }
  };

  const boundedPages = pages.map(page => {
    addOutputBytes(page.text);
    return { pageNumber: page.num, text: page.text };
  });
  const text = boundedPages.length === 0 ? fallbackText : undefined;
  if (text !== undefined) addOutputBytes(text);
  if (maxOutputBytes !== undefined) addOutputBytes(JSON.stringify(outline) ?? '');

  return {
    outline,
    pages: boundedPages,
    ...(text === undefined ? {} : { text }),
  };
};
