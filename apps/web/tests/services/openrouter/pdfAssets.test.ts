import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { buildAssessmentDocumentPrompt } from '../../../services/openrouter/assessment.ts';
import {
  getPdfTextSession,
  validatePdfTextSource,
} from '../../../services/openrouter/pdfAssets.ts';
import type { FileData } from '../../../types.ts';

const pdfFile: FileData = {
  sourceId: 'synthetic-source',
  name: 'synthetic.pdf',
  mimeType: 'application/pdf',
  data: 'ZmFrZS1wZGY=',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test('PDF admission, indexing and assessment reuse text extraction without image requests', async () => {
  const text = 'Il diagramma rappresenta un circuito con un generatore e due resistenze. '.repeat(
    8
  );
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      parser: 'pdftotext',
      text,
      pages: [{ pageNumber: 1, text }],
      pageCount: 1,
      sourceHash: 'synthetic-hash',
      outline: [{ title: '  Circuiti  ', page: 1, children: [] }],
      outlineOrigin: 'native',
    }),
  });
  vi.stubGlobal('fetch', fetchMock);

  const report = await validatePdfTextSource(pdfFile);
  const session = await getPdfTextSession(pdfFile);
  const assessment = await buildAssessmentDocumentPrompt(pdfFile);

  assert.equal(report?.status, 'ok');
  assert.equal(session?.extractedText, text);
  assert.deepEqual(session?.pages, [{ pageNumber: 1, text }]);
  assert.deepEqual(session?.images, []);
  assert.equal(session?.sourceHash, 'synthetic-hash');
  assert.equal(session?.outlineOrigin, 'native');
  assert.deepEqual(session?.outline, [
    {
      id: 'synthetic-source:outline:pdf-1',
      title: 'Circuiti',
      level: 1,
      page: 1,
      children: [],
    },
  ]);
  assert.equal(assessment.hasReliableSourceContext, true);
  assert.ok(assessment.content.includes(text.trim()));
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.ok(String(fetchMock.mock.calls[0]?.[0]).endsWith('/api/pdf/extract-text'));
  assert.deepEqual(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body), {
    fileData: 'data:application/pdf;base64,ZmFrZS1wZGY=',
  });
});

test('failed PDF text extraction can be retried and empty text fails admission', async () => {
  const file = { ...pdfFile, name: 'empty.pdf' };
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, text: '', pages: [], pageCount: 1 }),
    });
  vi.stubGlobal('fetch', fetchMock);

  await assert.rejects(getPdfTextSession(file), /offline/);
  await assert.rejects(validatePdfTextSource(file), {
    code: 'PDF_TEXT_QUALITY_INSUFFICIENT',
    report: {
      averageCharsPerPage: 0,
      extractedCharacterCount: 0,
      pageCount: 1,
      status: 'no-text',
      substantivePageCount: 0,
      substantivePageRatio: 0,
    },
  });
  assert.equal(fetchMock.mock.calls.length, 2);
});
