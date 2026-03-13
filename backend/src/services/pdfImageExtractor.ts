import crypto from 'node:crypto';
import { extractImagesFromPdf } from 'pdf-extract-image';

const MIN_IMAGE_BYTES = 8_000;

export interface ExtractedPdfImage {
  id: string;
  mimeType: 'image/png';
  dataUrl: string;
  sizeBytes: number;
  hash: string;
}

const toDataUrl = (buffer: Buffer): string => `data:image/png;base64,${buffer.toString('base64')}`;

export const extractPdfImages = async (
  pdfDataUrl: string,
  limit = 36
): Promise<ExtractedPdfImage[]> => {
  const base64 = pdfDataUrl.replace(/^data:application\/pdf;base64,/i, '');
  const pdfBuffer = Buffer.from(base64, 'base64');
  const buffers = await extractImagesFromPdf(pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength));
  const dedupedImages = new Map<string, ExtractedPdfImage>();

  buffers.forEach((buffer, index) => {
    if (buffer.length < MIN_IMAGE_BYTES) {
      return;
    }

    const hash = crypto.createHash('sha1').update(buffer).digest('hex');
    if (dedupedImages.has(hash)) {
      return;
    }

    dedupedImages.set(hash, {
      id: `pdf-img-${String(index + 1).padStart(3, '0')}`,
      mimeType: 'image/png',
      dataUrl: toDataUrl(buffer),
      sizeBytes: buffer.length,
      hash,
    });
  });

  return Array.from(dedupedImages.values()).slice(0, limit);
};
