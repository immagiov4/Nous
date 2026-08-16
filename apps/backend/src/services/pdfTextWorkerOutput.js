export class PdfTextWorkerOutputLimitError extends Error {
  constructor() {
    super('PDF fallback output exceeds the configured limit.');
    this.name = 'PdfTextWorkerOutputLimitError';
  }
}

export const buildBoundedPdfTextWorkerPayload = ({
  fallbackText,
  maxOutputBytes,
  outline,
  pages,
}) => {
  let outputBytes = 0;
  const addOutputBytes = value => {
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
