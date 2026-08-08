import { describe, expect, test } from 'vitest';

import { buildCourseDocumentIndex } from '../../src/workflows/courseSourceIndex.js';

describe('course source index', () => {
  test('builds exact PDF page spans with the frozen source identity', () => {
    const index = buildCourseDocumentIndex(
      [
        {
          descriptor: {
            hash: 'a'.repeat(64),
            id: 'source-pdf',
            kind: 'pdf',
            mimeType: 'application/pdf',
            name: 'manuale.pdf',
          },
          pdf: {
            outline: [],
            outlineOrigin: 'none' as const,
            pageCount: 2,
            pages: [
              { pageNumber: 1, text: 'Pagina uno con contenuto.' },
              { pageNumber: 2, text: 'Pagina due con altro contenuto.' },
            ],
            parser: 'pdftotext' as const,
            sourceHash: 'a'.repeat(64),
            text: 'Pagina uno con contenuto.\n\nPagina due con altro contenuto.',
            usedFallbackParser: false,
          },
          text: 'Pagina uno con contenuto.\n\nPagina due con altro contenuto.',
        },
      ],
      () => '2026-07-30T14:00:00.000Z'
    );

    expect(index).toMatchObject({
      pageCount: 2,
      parsedAt: '2026-07-30T14:00:00.000Z',
      sourceHash: 'a'.repeat(64),
      sourceIds: ['source-pdf'],
    });
    expect(index?.chunks[0]).toMatchObject({
      id: 'source-pdf:chunk-001',
      pageEnd: 2,
      pageStart: 1,
      sourceId: 'source-pdf',
    });
  });

  test('combines source-set chunks in stable source order without identity collisions', () => {
    const index = buildCourseDocumentIndex(
      [
        {
          descriptor: {
            hash: 'b'.repeat(64),
            id: 'source-b',
            kind: 'markdown',
            mimeType: 'text/markdown',
            name: 'zeta.md',
          },
          text: 'Contenuto Z',
        },
        {
          descriptor: {
            hash: 'a'.repeat(64),
            id: 'source-a',
            kind: 'text',
            mimeType: 'text/plain',
            name: 'alfa.txt',
          },
          text: 'Contenuto A',
        },
      ],
      () => '2026-07-30T14:00:00.000Z'
    );

    expect(index?.sourceIds).toEqual(['source-a', 'source-b']);
    expect(index?.chunks.map(chunk => chunk.id)).toEqual([
      'source-a:chunk-001',
      'source-b:chunk-001',
    ]);
    expect(index?.chunks.map(chunk => chunk.headingPath[0])).toEqual(['alfa.txt', 'zeta.md']);
    expect(index?.chunks.map(chunk => chunk.sequence)).toEqual([0, 1]);
  });
});
