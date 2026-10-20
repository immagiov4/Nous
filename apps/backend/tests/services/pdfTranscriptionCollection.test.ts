import { expect, test, vi } from 'vitest';
import type { SourcePreparationContext } from '../../src/projects/sourcePreparationContext.js';
import {
  countRetainedScannedPages,
  withPdfTranscriptionCollection,
} from '../../src/services/pdfTranscriptionCollection.js';
import type { PdfTranscriptionPool } from '../../src/services/pdfTranscriptionPool.js';

const prepared = {
  text: 'Synthetic mathematical source',
  sourceHash: 'synthetic',
  parser: 'pdf-parse',
  usedFallbackParser: false,
  outline: [],
  outlineOrigin: 'none',
  failedPages: [2],
  blankPages: [3],
  pages: [
    {
      pageNumber: 1,
      text: 'Synthetic transcription',
      provenance: {
        kind: 'vision-transcription',
        pageNumber: 1,
        model: 'synthetic',
        provider: 'openrouter',
      },
    },
    { pageNumber: 2, text: '' },
    { pageNumber: 3, text: '' },
    { pageNumber: 4, text: 'Clean selectable text' },
  ],
};
const context = (): SourcePreparationContext => ({
  userId: 'synthetic-user',
  uploadId: 'synthetic-upload',
  projectId: 'synthetic-course',
  signal: new AbortController().signal,
  reportProgress: vi.fn(),
  previousScannedPages: 149,
});

test('counts only authoritative retained scanned pages, excluding replacements and clean pages', () => {
  const saved = {
    sources: [
      { id: 'retained', preparedPdfText: prepared },
      { id: 'replaced', preparedPdfText: prepared },
      { id: 'removed', preparedPdfText: prepared },
    ],
  };
  const next = {
    sources: [
      {
        id: 'retained',
        preparedPdfText: { ...prepared, failedPages: [], blankPages: [], pages: [] },
      },
      { id: 'replaced', preparedPdfText: prepared },
      { id: 'added', preparedPdfText: prepared },
    ],
  };
  expect(countRetainedScannedPages(saved, next, ['replaced', 'added'])).toBe(3);
  expect(countRetainedScannedPages(null, next, [])).toBe(0);
  expect(countRetainedScannedPages(saved, { sources: [] }, [])).toBe(0);
});

test('deduplicates page identities without trusting client-provided transcription counts', () => {
  const source = {
    sources: [
      {
        id: 'retained',
        preparedPdfText: { ...prepared, failedPages: [1, 2, 2], blankPages: [3, 3] },
      },
    ],
  };
  expect(countRetainedScannedPages(source, { sources: [{ id: 'retained' }] }, [])).toBe(3);
});

test.each([
  false,
  true,
])('closes the one collection pool after its operation; failure=%s', async fail => {
  const job = context();
  const error = new Error('Synthetic preparation failure');
  let pool: PdfTranscriptionPool | undefined;
  const pending = withPdfTranscriptionCollection(job, async () => {
    pool = job.pdfTranscriptionPool;
    expect(pool?.allocateScannedPages(2).map(page => page.tier)).toEqual(['full', 'reduced']);
    if (fail) throw error;
    return 'prepared';
  });
  if (fail) await expect(pending).rejects.toBe(error);
  else await expect(pending).resolves.toBe('prepared');
  expect(pool?.signal.aborted).toBe(true);
});
