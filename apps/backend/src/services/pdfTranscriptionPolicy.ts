import {
  PDF_SCANNED_PAGE_LIMIT_CODE,
  PDF_SCANNED_PAGE_LIMIT_MESSAGE,
} from '@shared/pdfTranscription';
import * as z from 'zod';

const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const policySchema = z
  .object({
    fullQualityPages: z.coerce.number().int().positive().default(150),
    maxScannedPages: z.coerce.number().int().positive().default(300),
    fullModel: z.string().trim().min(1).default('openai/gpt-6-luna'),
    reducedModel: z.string().trim().min(1).default('openai/gpt-6-luna'),
    fullEffort: effort.default('xhigh'),
    reducedEffort: effort.default('medium'),
  })
  .refine(policy => policy.fullQualityPages <= policy.maxScannedPages, {
    message: 'The full-quality page allowance cannot exceed the course scanned-page limit.',
  });

export const readPdfTranscriptionPolicy = () =>
  policySchema.parse({
    fullQualityPages: process.env.PDF_TRANSCRIPTION_FULL_QUALITY_PAGES,
    maxScannedPages: process.env.PDF_TRANSCRIPTION_MAX_SCANNED_PAGES,
    fullModel: process.env.MODEL_PDF_TRANSCRIPTION,
    reducedModel: process.env.MODEL_PDF_TRANSCRIPTION_REDUCED,
    fullEffort: process.env.PDF_TRANSCRIPTION_REASONING_EFFORT,
    reducedEffort: process.env.PDF_TRANSCRIPTION_REDUCED_REASONING_EFFORT,
  });

export interface PdfTranscriptionSelection {
  ordinal: number;
  tier: 'full' | 'reduced';
  model: string;
  reasoningEffort: z.infer<typeof effort>;
}

export class PdfScannedPageLimitError extends Error {
  readonly code = PDF_SCANNED_PAGE_LIMIT_CODE;
  constructor(readonly limit: number) {
    super(PDF_SCANNED_PAGE_LIMIT_MESSAGE);
    this.name = 'PdfScannedPageLimitError';
  }
}
