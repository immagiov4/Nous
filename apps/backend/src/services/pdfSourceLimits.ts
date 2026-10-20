import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import type { PdfTextExtractionOptions } from './pdfTextExtractor.js';

const MAX_PDF_TEXT_BYTES = 64_000_000;
// The parser can retain aggregate and per-page UTF-16 text at the same time.
const FALLBACK_TEXT_HEAP_MULTIPLIER = 4;
const BYTES_PER_MEGABYTE = 1_000_000;

export const PDF_SOURCE_EXTRACTION_OPTIONS = {
  fallbackTimeoutMs: 15_000,
  maxOutputBytes: MAX_PDF_TEXT_BYTES,
  pdftotextTimeoutMs: 15_000,
  fallbackProcessMaxOldGenerationSizeMb: Math.ceil(
    (COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes +
      MAX_PDF_TEXT_BYTES * FALLBACK_TEXT_HEAP_MULTIPLIER) /
      BYTES_PER_MEGABYTE
  ),
} as const satisfies PdfTextExtractionOptions;
