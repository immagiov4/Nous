// Validates and strips PDF data URL prefixes.
const PDF_DATA_URL_PREFIX = /^data:application\/pdf;base64,/i;
export const PDF_DATA_URL_REQUIRED_MESSAGE = 'E richiesto un data URL PDF valido.';

export const isPdfDataUrl = (value: unknown): value is string =>
  typeof value === 'string' && PDF_DATA_URL_PREFIX.test(value);

export const decodePdfDataUrl = (pdfDataUrl: string): Buffer => {
  if (!isPdfDataUrl(pdfDataUrl)) {
    throw new Error(PDF_DATA_URL_REQUIRED_MESSAGE);
  }

  return Buffer.from(pdfDataUrl.replace(PDF_DATA_URL_PREFIX, ''), 'base64');
};

export const encodePdfDataUrl = (pdfBytes: Uint8Array): string =>
  `data:application/pdf;base64,${Buffer.from(pdfBytes).toString('base64')}`;
