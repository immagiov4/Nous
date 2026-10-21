import { readFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';
import { expect, test } from 'vitest';
import {
  inspectPdfTextPages,
  PDF_PAGE_LOAD_OPTIONS,
} from '../../src/services/pdfPageProcessing.mjs';
import { buildPdfPageFixture } from '../fixtures/pdfText.js';

const extracted = (
  pages: Array<{ pageNumber: number; text: string }>,
  parser: 'pdf-parse' | 'pdftotext' = 'pdf-parse'
) => ({
  text: '',
  sourceHash: 'synthetic',
  usedFallbackParser: true,
  outline: [],
  outlineOrigin: 'none' as const,
  pages,
  parser,
});

async function inspect(bytes: Buffer, source: ReturnType<typeof extracted>) {
  const parser = new PDFParse({ data: bytes, ...PDF_PAGE_LOAD_OPTIONS });
  try {
    return await inspectPdfTextPages(parser, source);
  } finally {
    await parser.destroy();
  }
}

test('keeps physical page order and plans omitted blank and invisible OCR pages', async () => {
  const bytes = buildPdfPageFixture([
    'BT /F1 12 Tf 10 100 Td (Clean first page) Tj ET',
    'BT /F1 12 Tf 3 Tr 10 100 Td (Hidden OCR) Tj ET',
    '',
  ]);
  const result = await inspect(
    bytes,
    extracted([
      { pageNumber: 2, text: 'Hidden OCR' },
      { pageNumber: 1, text: 'Clean first page' },
    ])
  );
  expect(result).toEqual({
    pageCount: 3,
    pages: [
      { pageNumber: 1, text: 'Clean first page' },
      { pageNumber: 2, text: 'Hidden OCR' },
      { pageNumber: 3, text: '' },
    ],
    planned: [
      { pageNumber: 2, reasons: ['invisible-text-layer'] },
      { pageNumber: 3, reasons: ['empty-text'] },
    ],
  });
});

test('recovers text omitted by pdftotext without scheduling paid transcription', async () => {
  const result = await inspect(
    buildPdfPageFixture(['BT /F1 12 Tf 10 100 Td (Recovered text) Tj ET']),
    extracted([], 'pdftotext')
  );
  expect(result).toEqual({
    pageCount: 1,
    pages: [{ pageNumber: 1, text: 'Recovered text' }],
    planned: [],
  });
});

test('retains full-page raster and invisible OCR evidence', async () => {
  const bytes = await readFile(new URL('../fixtures/synthetic-proof.pdf', import.meta.url));
  const result = await inspect(bytes, extracted([], 'pdftotext'));
  expect(result.pageCount).toBe(1);
  expect(result.planned).toEqual([
    {
      pageNumber: 1,
      reasons: ['empty-text', 'full-page-image', 'lost-text-glyph', 'invisible-text-layer'],
    },
  ]);
});
