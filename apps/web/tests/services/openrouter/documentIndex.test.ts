import assert from 'node:assert/strict';
import { buildPdfTextIndex } from '@shared/pdfTextIndex';
import { test } from 'vitest';
import { resolveLessonContextChunks } from '../../../services/openrouter/documentIndex/index.ts';
import type { PdfTextIndex } from '../../../types.ts';

test('multi-source lesson retrieval never pulls an adjacent chunk from another source', () => {
  const index: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-07-11T00:00:00.000Z',
    chunks: [
      {
        id: 'source-a:chunk-001',
        sourceId: 'source-a',
        sequence: 0,
        headingPath: ['A'],
        text: 'A one',
        startOffset: 0,
        endOffset: 5,
      },
      {
        id: 'source-a:chunk-002',
        sourceId: 'source-a',
        sequence: 1,
        headingPath: ['A'],
        text: 'A two',
        startOffset: 6,
        endOffset: 11,
      },
      {
        id: 'source-b:chunk-001',
        sourceId: 'source-b',
        sequence: 2,
        headingPath: ['B'],
        text: 'B one',
        startOffset: 0,
        endOffset: 5,
      },
    ],
  };

  assert.deepEqual(
    resolveLessonContextChunks(index, ['source-b:chunk-001']).map(chunk => chunk.id),
    ['source-b:chunk-001']
  );
});

test('buildPdfTextIndex stores exact chunk page spans when per-page text is available', () => {
  const documentIndex = buildPdfTextIndex('unused', 'hash-1', 'Game Engine Architecture', [
    { pageNumber: 10, text: 'Intro systems' },
    { pageNumber: 11, text: 'Deferred decals and material overlays' },
    { pageNumber: 12, text: 'Camera ambient occlusion and clipping planes' },
  ]);

  assert.equal(documentIndex.pageCount, 3);
  assert.deepEqual(
    documentIndex.chunks.map(chunk => ({
      id: chunk.id,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
    })),
    [{ id: 'chunk-001', pageStart: 10, pageEnd: 12 }]
  );
});
