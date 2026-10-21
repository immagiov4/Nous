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
    name: 'PdfScannedPageLimitError',
  });
});

test('retains document and failed page identities when the whole collection has no usable text', async () => {
  const input = await fixture();
  const pdf = {
    ...input.extracted,
    transcription: {
      pages: [],
      failedPages: [1],
      blankPages: [],
      measurements: [],
      inputTokens: 1,
      outputTokens: 2,
    },
  };
  mocks.prepare.mockResolvedValue({ completion: Promise.resolve(pdf) });
  await expect(prepareSourceCollection(input)).rejects.toMatchObject({
    failures: [{ name: 'scan.pdf', reason: 'no-usable-text', failedPages: [1] }],
  });
});

test('restores authoritative retained transcripts before publishing the prepared collection', async () => {
  const input = await fixture();
  const preparedPdfText = {
    sourceHash: 'saved-hash',
    pages: [{ pageNumber: 1, text: 'Stored text' }],
  };
  const retained = {
    ...input.snapshot.source.sources[0],
    id: 'retained',
    hash: 'saved-hash',
    preparedPdfText: { text: 'Client forged text' },
  };
  input.snapshot.source.sources.push(retained);
  mocks.prepare.mockResolvedValue({
    completion: Promise.resolve({
      ...input.extracted,
      text: 'New upload',
      pages: [{ pageNumber: 1, text: 'New upload' }],
    }),
  });
  const result = await prepareSourceCollection({
    ...input,
    storedSnapshot: {
      ...input.snapshot,
      source: { sources: [{ ...retained, preparedPdfText }] },
    },
  });
  expect(result.snapshot.source).toMatchObject({
    sources: [{ preparedPdfText: { text: 'New upload' } }, { id: 'retained', preparedPdfText }],
  });
});

test('reattachment reuses the stored hash-bound transcript instead of paying for the same PDF again', async () => {
  const input = await fixture();
  const pdf = {
    ...input.extracted,
    text: 'Already transcribed page.',
    pages: [
      {
        pageNumber: 1,
        text: 'Already transcribed page.',
        provenance: {
          kind: 'vision-transcription' as const,
          pageNumber: 1,
          model: 'synthetic',
          provider: 'openrouter',
        },
      },
    ],
  };
  const stored = {
    ...input.snapshot.source.sources[0],
    hash: pdf.sourceHash,
    preparedPdfText: pdf,
  };
  const result = await prepareSourceCollection({
    ...input,
    storedSnapshot: { ...input.snapshot, source: { ...input.snapshot.source, sources: [stored] } },
  });
  expect(result.snapshot.source).toMatchObject({
    sources: [{ preparedPdfText: { text: pdf.text } }],
  });
  expect(mocks.extract).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

test('a later file failure retains an earlier paid transcript for a retry', async () => {
  const input = await fixture();
  const second = { ...input.upload.files[0], id: 'second', name: 'second.pdf' };
  const snapshot = structuredClone(input.snapshot);
  snapshot.source.sources.push({
    ...snapshot.source.sources[0],
    ...second,
    file: { ...second, data: '' },
  });
  await writeFile(input.upload.path, Buffer.concat([input.bytes, input.bytes]));
  const checkpoint = vi.fn();
  const pdf = {
    ...input.extracted,
    text: 'Paid page text',
    pages: [{ pageNumber: 1, text: 'Paid page text' }],
  };
  mocks.prepare
    .mockResolvedValueOnce({ completion: Promise.resolve(pdf) })
    .mockRejectedValueOnce(new PdfScannedPageLimitError());
  await expect(
    prepareSourceCollection({
      ...input,
      snapshot,
      upload: { ...input.upload, files: [...input.upload.files, second] },
      context: { ...input.context, checkpointPreparedSources: checkpoint },
    })
  ).rejects.toBeInstanceOf(PdfScannedPageLimitError);
  expect(checkpoint).toHaveBeenCalled();
  const preparedSnapshot = checkpoint.mock.calls.at(-1)?.[0];
  expect(preparedSnapshot.source.sources[0].preparedPdfText.text).toBe(pdf.text);
  await writeFile(input.upload.path, input.bytes);
  mocks.extract.mockClear();
  mocks.prepare.mockClear();
  const result = await prepareSourceCollection({ ...input, preparedSnapshot });
  expect(result.snapshot.source).toMatchObject({
    sources: [{ preparedPdfText: { text: pdf.text } }],
  });
  expect(mocks.extract).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

test.each([
  'blank',
  'unreadable',
] as const)('retry reuses the completed %s page outcome without another provider call', async outcome => {
  const input = await fixture();
  const checkpoint = vi.fn();
  const identities = {
    blankPages: outcome === 'blank' ? [1] : [],
    failedPages: outcome === 'unreadable' ? [1] : [],
  };
  mocks.prepare.mockResolvedValue({
    completion: Promise.resolve({
      ...input.extracted,
      transcription: {
        ...identities,
        pages: [],
        measurements: [],
        inputTokens: 1,
        outputTokens: 1,
      },
    }),
  });
  await expect(
    prepareSourceCollection({
      ...input,
      context: { ...input.context, checkpointPreparedSources: checkpoint },
    })
  ).rejects.toThrow('Nessuna delle fonti contiene testo utilizzabile');
  const preparedSnapshot = checkpoint.mock.calls.at(-1)?.[0];
  expect(preparedSnapshot.source.sources[0].preparedPdfText).toMatchObject(identities);
  mocks.extract.mockClear();
  mocks.prepare.mockClear();
  await expect(prepareSourceCollection({ ...input, preparedSnapshot })).rejects.toThrow(
    'Nessuna delle fonti contiene testo utilizzabile'
  );
  expect(mocks.extract).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
