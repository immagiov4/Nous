import { PreparedPdfTextSchema } from '@shared/pdfTranscription';
import { isRecord } from '../utils/validation.js';
import type { PdfTranscriptionOptions } from './pdfPageTranscription.js';
import { type ExtractedPdfText, extractPdfText } from './pdfTextExtractor.js';

export const isPdfProjectSourceFile = (file: { mimeType: string; name: string }): boolean =>
  file.mimeType.toLowerCase() === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

export const readProjectSourceText = async (
  file: {
    data: string;
    mimeType: string;
    name: string;
  },
  transcription?: PdfTranscriptionOptions
): Promise<string> => {
  return (await readProjectSourceMaterial(file, transcription)).text;
};

export interface ProjectSourceMaterial {
  pdf?: ExtractedPdfText;
  text: string;
}

export const readProjectSourceMaterial = async (
  file: {
    data: string;
    mimeType: string;
    name: string;
  },
  transcription?: PdfTranscriptionOptions
): Promise<ProjectSourceMaterial> => {
  if (isPdfProjectSourceFile(file)) {
    const pdf = await extractPdfText(
      `data:${file.mimeType};base64,${file.data}`,
      transcription ? { transcription } : {}
    );
    return { pdf, text: pdf.text };
  }
  return { text: Buffer.from(file.data, 'base64').toString('utf8') };
};

/** Reuse the source-bound, durable upload result across course workflow stages and restarts. */
const readPreparedPdfText = (value: unknown, sourceHash: string): ExtractedPdfText | null => {
  const parsed = PreparedPdfTextSchema.safeParse(value);
  return parsed.success && parsed.data.sourceHash === sourceHash ? parsed.data : null;
};

/** Resolves a prepared page transcript from either the single-source or multi-source snapshot. */
export const readPreparedProjectPdfText = (
  source: unknown,
  sourceId: string,
  sourceHash: string
): ExtractedPdfText | null => {
  if (!isRecord(source)) return null;
  const descriptor = Array.isArray(source.sources)
    ? source.sources.find(entry => isRecord(entry) && entry.id === sourceId)
    : source;
  return isRecord(descriptor) ? readPreparedPdfText(descriptor.preparedPdfText, sourceHash) : null;
};
