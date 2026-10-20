import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { prepareSourceCollection } from '../../src/projects/sourceIngestion.js';
import { PdfScannedPageLimitError } from '../../src/services/pdfTranscriptionPolicy.js';

const mocks = vi.hoisted(() => ({ extract: vi.fn(), prepare: vi.fn() }));
vi.mock('../../src/services/pdfTextExtractor.js', async original => ({
  ...(await original<typeof import('../../src/services/pdfTextExtractor.js')>()),
  extractPdfText: mocks.extract,
}));
vi.mock('../../src/services/pdfPageTranscription.js', () => ({
  preparePdfTextExtraction: mocks.prepare,
}));
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nous-transcription-ingestion-'));
  directories.push(directory);
  const path = join(directory, 'sources');
  const bytes = Buffer.from('%PDF-synthetic');
  await writeFile(path, bytes);
  const file = {
    id: 'scan',
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    byteSize: bytes.length,
  };
  const snapshot = {
    id: 'course',
    version: '4.1',
    createdAt: '',
    updatedAt: '',
    lastOpenedAt: '',
    source: {
      kind: 'document',
      sources: [
        {
          ...file,
          hash: '0'.repeat(64),
          status: 'ready',
          preparedPdfText: { text: 'untrusted submitted transcript' },
          file: { ...file, data: '' },
        },
      ],
    },
  };
  const context = {
    userId: 'learner',
    uploadId: 'upload',
    projectId: 'course',
    signal: new AbortController().signal,
    reportProgress: vi.fn(),
  };
  const extracted = {
    text: '',
    pages: [{ pageNumber: 1, text: '' }],
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    parser: 'pdf-parse' as const,
    usedFallbackParser: true,
    outline: [],
    outlineOrigin: 'none' as const,
  };
  mocks.extract.mockResolvedValue(extracted);
  return { snapshot, upload: { path, files: [file] }, context, extracted, bytes };
};

test('ingestion persists the server transcript, its page provenance and failed/blank page identities', async () => {
  const input = await fixture();
  const pdf = {
    ...input.extracted,
    text: 'Definition of a finite set.',
    pages: [
      {
        pageNumber: 1,
        text: 'Definition of a finite set.',
        provenance: {
          kind: 'vision-transcription',
          pageNumber: 1,
          model: 'synthetic',
          provider: 'openrouter',
        },
      },
    ],
    transcription: {
      pages: [1],
      failedPages: [2],
      blankPages: [3],
      measurements: [],
      inputTokens: 1,
      outputTokens: 2,
    },
  };
  mocks.prepare.mockResolvedValue({ completion: Promise.resolve(pdf) });
  const result = await prepareSourceCollection(input);
  expect(mocks.prepare).toHaveBeenCalledWith(input.bytes, input.extracted, {
    context: input.context,
    documentName: 'scan.pdf',
  });
  expect(result.snapshot.source).toMatchObject({
    sources: [
      {
        status: 'ready',
        hash: input.extracted.sourceHash,
        preparedPdfText: { text: pdf.text, pages: pdf.pages, failedPages: [2], blankPages: [3] },
      },
    ],
  });
  expect(result.snapshot.documentIndex).toMatchObject({ chunks: [{ transcribedPages: [1] }] });
});

test('course admission errors reach the job instead of becoming per-file parser failures', async () => {
  const input = await fixture();
  mocks.prepare.mockRejectedValue(new PdfScannedPageLimitError(300));
  await expect(prepareSourceCollection(input)).rejects.toMatchObject({
    code: 'PDF_SCANNED_PAGE_LIMIT',
  });
});
