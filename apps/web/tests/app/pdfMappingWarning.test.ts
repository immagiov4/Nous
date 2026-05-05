import { describe, expect, test } from 'vitest';
import { resolvePdfMappingWarning } from '../../app/pdfMappingWarning.ts';
import type { PdfTextIndex, ProjectSource } from '../../types.ts';

const pdfSource: ProjectSource = {
  kind: 'pdf',
  file: {
    data: 'base64',
    mimeType: 'application/pdf',
    name: 'book.pdf',
  },
};

const buildDocumentIndex = (overrides: Partial<PdfTextIndex> = {}): PdfTextIndex => ({
  chunks: [
    {
      endOffset: 4,
      headingPath: [],
      id: 'chunk-1',
      pageEnd: 1,
      pageStart: 1,
      sequence: 0,
      startOffset: 0,
      text: 'test',
    },
  ],
  kind: 'pdf-text-index',
  parsedAt: '2026-05-05T00:00:00.000Z',
  ...overrides,
});

describe('resolvePdfMappingWarning', () => {
  test('does not show an actionless warning while the PDF index is unavailable', () => {
    expect(resolvePdfMappingWarning(pdfSource, null)).toBeNull();
    expect(resolvePdfMappingWarning(pdfSource, buildDocumentIndex({ chunks: [] }))).toBeNull();
  });

  test('shows explicit mapping warnings produced by the PDF index', () => {
    expect(
      resolvePdfMappingWarning(
        pdfSource,
        buildDocumentIndex({ mappingWarnings: ['copertura bassa'] })
      )
    ).toBe('Mappatura PDF da controllare: copertura bassa');
  });
});
