import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  getProjectSourceWarnings,
  prepareUploadedCourseSource,
  readSourceFileData,
} from '../../../../hooks/workspace/controller/controllerContext.ts';
import { setRenderingLocaleOverride } from '../../../../i18n/uiMessages.ts';
import { readProcessingResponse } from '../../../../services/processingResponse.ts';
import { decodeTextBase64 } from '../../../../services/projects/projectSource.ts';

test('readSourceFileData accepts markdown uploads with missing mime type', async () => {
  const file = new File(['# Titolo\n\nContenuto'], 'notes.md');

  const result = await readSourceFileData(file);

  assert.equal(result.name, 'notes.md');
  assert.equal(result.mimeType, 'text/markdown');
  assert.equal(decodeTextBase64(result.data), '# Titolo\n\nContenuto');
});

test('readSourceFileData normalizes common text formats', async () => {
  const cases = [
    { expectedMimeType: 'application/json', file: new File(['{"ok":true}'], 'data.json') },
    { expectedMimeType: 'application/xml', file: new File(['<root />'], 'feed.xml') },
    { expectedMimeType: 'text/plain', file: new File(['started'], 'server.log') },
  ];

  for (const testCase of cases) {
    const result = await readSourceFileData(testCase.file);
    assert.equal(result.mimeType, testCase.expectedMimeType);
  }
});

test('readSourceFileData rejects unsupported binary uploads', async () => {
  const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])], 'image.bin');

  await assert.rejects(
    () => readSourceFileData(file),
    /Sono supportati PDF, ZIP o file di testo\./
  );
});

test('prepareUploadedCourseSource builds one stable logical source set from multiple files', async () => {
  const progress: Array<[number, number]> = [];
  const context = { openRouter: {} } as Parameters<typeof prepareUploadedCourseSource>[0];
  const result = await prepareUploadedCourseSource(
    context,
    [
      new File(['Beta'], 'zeta.txt', { type: 'text/plain' }),
      new File(['# Alpha'], 'Alpha.md', { type: 'text/markdown' }),
    ],
    (completed, total) => progress.push([completed, total])
  );

  assert.deepEqual(
    result.descriptors.map(source => source.name),
    ['Alpha.md', 'zeta.txt']
  );
  assert.equal(result.source.sources?.length, 2);
  assert.deepEqual(progress, [
    [0, 2],
    [1, 2],
    [2, 2],
  ]);
});

test('prepareUploadedCourseSource keeps usable sources when one PDF cannot be indexed', async () => {
  const context = {
    openRouter: {
      validatePdfTextSource: async () => {
        throw new Error('no selectable text');
      },
    },
  } as unknown as Parameters<typeof prepareUploadedCourseSource>[0];

  const result = await prepareUploadedCourseSource(context, [
    new File(['%PDF-1.7\n'], 'broken.pdf', { type: 'application/pdf' }),
    new File(['Useful notes'], 'notes.txt', { type: 'text/plain' }),
  ]);

  assert.equal(result.descriptors.find(source => source.name === 'broken.pdf')?.status, 'error');
  assert.equal(result.descriptors.find(source => source.name === 'notes.txt')?.status, 'ready');
  assert.equal(result.source.sources?.length, 2);
});

test('multiple-source warnings retain failed transcription pages in the interface language', async () => {
  setRenderingLocaleOverride('en');
  const context = {
    openRouter: {
      validatePdfTextSource: () =>
        readProcessingResponse(
          new Response(
            JSON.stringify({
              type: 'error',
              failedPages: [2, 7],
              error: 'private provider details',
            }),
            { headers: { 'Content-Type': 'application/x-ndjson' } }
          )
        ),
    },
  } as unknown as Parameters<typeof prepareUploadedCourseSource>[0];
  try {
    const result = await prepareUploadedCourseSource(context, [
      new File(['%PDF-1.7\n'], 'scan.pdf', { type: 'application/pdf' }),
      new File(['Useful notes'], 'notes.txt', { type: 'text/plain' }),
    ]);
    assert.deepEqual(getProjectSourceWarnings(result.source), [
      { name: 'scan.pdf', message: 'Transcription failed for pages: 2, 7.' },
    ]);
    assert.equal(result.descriptors.find(source => source.name === 'notes.txt')?.status, 'ready');
  } finally {
    setRenderingLocaleOverride(null);
  }
});

test('reports every failed document and its pages when all selected PDFs fail transcription', async () => {
  setRenderingLocaleOverride('en');
  const context = {
    openRouter: {
      validatePdfTextSource: (file: { name: string }) =>
        readProcessingResponse(
          new Response(
            JSON.stringify({
              type: 'error',
              failedPages: file.name === 'a.pdf' ? [2] : [7],
              error: 'private provider details',
            }),
            { headers: { 'Content-Type': 'application/x-ndjson' } }
          )
        ),
    },
  } as unknown as Parameters<typeof prepareUploadedCourseSource>[0];
  try {
    await assert.rejects(
      prepareUploadedCourseSource(context, [
        new File(['%PDF-1.7\n'], 'b.pdf', { type: 'application/pdf' }),
        new File(['%PDF-1.7\n'], 'a.pdf', { type: 'application/pdf' }),
      ]),
      {
        message:
          'None of the selected sources contains usable material.\na.pdf: Transcription failed for pages: 2.\nb.pdf: Transcription failed for pages: 7.',
      }
    );
  } finally {
    setRenderingLocaleOverride(null);
  }
});
