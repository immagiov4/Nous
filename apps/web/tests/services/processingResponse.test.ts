import { afterEach, expect, test } from 'vitest';
import { setRenderingLocaleOverride } from '../../i18n/uiMessages.ts';
import {
  formatPdfTranscriptionProgress,
  readProcessingResponse,
} from '../../services/processingResponse.ts';

afterEach(() => setRenderingLocaleOverride(null));

test.each([
  [
    'it',
    'Trascrizione pagine scansionate 151/170\nPagine 151–170 trascritte in qualità ridotta.\nappunti.pdf, pagina 3: non trascritta.',
  ],
  [
    'en',
    'Transcribing scanned pages 151/170\nPages 151–170 transcribed at reduced quality.\nappunti.pdf, page 3: not transcribed.',
  ],
] as const)('formats collection tier ranges and missing-page identities in %s', (locale, message) => {
  setRenderingLocaleOverride(locale);
  expect(
    formatPdfTranscriptionProgress({
      completed: 151,
      total: 170,
      failedPages: [3],
      reducedQuality: { from: 151, to: 170 },
      failures: [{ documentName: 'appunti.pdf', pageNumber: 3 }],
    })
  ).toBe(message);
});

test.each([
  [
    'it',
    'Il materiale scansionato è troppo per un solo corso. Seleziona solo le parti che ti servono.',
  ],
  ['en', 'There is too much scanned material for one course. Select only the parts you need.'],
] as const)('maps a course-wide scanned-page limit to a localized safe error in %s', async (locale, message) => {
  setRenderingLocaleOverride(locale);
  const response = new Response(
    JSON.stringify({
      type: 'error',
      code: 'PDF_SCANNED_PAGE_LIMIT',
      error: 'private provider detail',
    }),
    { headers: { 'content-type': 'application/x-ndjson' } }
  );
  await expect(readProcessingResponse(response)).rejects.toMatchObject({ message });
});
