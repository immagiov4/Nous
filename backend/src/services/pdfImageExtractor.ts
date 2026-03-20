import crypto from 'node:crypto';
import { PDFParse } from 'pdf-parse';

const MIN_IMAGE_BYTES = 8_000;

export interface ExtractedPdfImage {
  id: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
  hash: string;
}

const PDF_DATA_URL_PREFIX = /^data:application\/pdf;base64,/i;

const getMimeTypeFromDataUrl = (dataUrl: string): string => {
  const match = /^data:([^;]+);base64,/i.exec(dataUrl);
  return match?.[1] || 'image/png';
};

export const extractPdfImages = async (
  pdfDataUrl: string,
  limit = 36
): Promise<ExtractedPdfImage[]> => {
  const base64 = pdfDataUrl.replace(PDF_DATA_URL_PREFIX, '');
  const pdfBuffer = Buffer.from(base64, 'base64');
  const parser = new PDFParse({ data: pdfBuffer });
  const dedupedImages = new Map<string, ExtractedPdfImage>();

  try {
    const imageResult = await parser.getImage({ imageThreshold: 80 });
    imageResult.pages.forEach(page => {
      page.images.forEach(image => {
        const dataBuffer = Buffer.from(image.data);
        if (dataBuffer.length < MIN_IMAGE_BYTES || !image.dataUrl) {
          return;
        }

        const hash = crypto.createHash('sha1').update(dataBuffer).digest('hex');
        if (dedupedImages.has(hash)) {
          return;
        }

        dedupedImages.set(hash, {
          id: `pdf-img-${String(dedupedImages.size + 1).padStart(3, '0')}`,
          mimeType: getMimeTypeFromDataUrl(image.dataUrl),
          dataUrl: image.dataUrl,
          sizeBytes: dataBuffer.length,
          hash,
        });
      });
    });
  } finally {
    await parser.destroy().catch(() => undefined);
  }

  return Array.from(dedupedImages.values()).slice(0, limit);
};
