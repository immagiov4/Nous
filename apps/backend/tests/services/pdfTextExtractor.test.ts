import { describe, expect, test } from 'vitest';
import { buildDeterministicPdfOutline } from '../../src/services/pdfTextExtractor.js';
import {
  buildBoundedPdfTextWorkerPayload,
  PdfTextWorkerOutputLimitError,
} from '../../src/services/pdfTextWorkerOutput.js';

describe('buildDeterministicPdfOutline', () => {
  test('builds a stable hierarchy from numbered headings and keeps page provenance', () => {
    const outline = buildDeterministicPdfOutline([
      {
        pageNumber: 2,
        text: '1 Fondamenti\n1.1 Concetti essenziali\nTesto normale che non e un titolo',
      },
      {
        pageNumber: 5,
        text: '1.1 Concetti essenziali\n2 Applicazioni\nCapitolo III Approfondimenti',
      },
    ]);

    expect(outline.map(node => node.title)).toEqual([
      '1 Fondamenti',
      '2 Applicazioni',
      'Capitolo III Approfondimenti',
    ]);
    expect(outline[0]?.children).toEqual([
      expect.objectContaining({ title: '1.1 Concetti essenziali', level: 2, page: 2 }),
    ]);
    expect(outline.flatMap(node => [node, ...node.children]).map(node => node.id)).toEqual([
      'outline-1',
      'outline-2',
      'outline-3',
      'outline-4',
    ]);
  });
});

describe('buildBoundedPdfTextWorkerPayload', () => {
  test('sends page text once and keeps it below the structured-clone budget', () => {
    const payload = buildBoundedPdfTextWorkerPayload({
      fallbackText: 'duplicato non necessario',
      maxOutputBytes: 32,
      outline: [],
      pages: [{ num: 3, text: 'Testo pagina' }],
    });

    expect(payload).toEqual({
      outline: [],
      pages: [{ pageNumber: 3, text: 'Testo pagina' }],
    });
  });

  test('rejects UTF-8 text and outlines that exceed the worker output budget', () => {
    expect(() =>
      buildBoundedPdfTextWorkerPayload({
        fallbackText: '',
        maxOutputBytes: 3,
        outline: [],
        pages: [{ num: 1, text: 'éé' }],
      })
    ).toThrow(PdfTextWorkerOutputLimitError);
    expect(() =>
      buildBoundedPdfTextWorkerPayload({
        fallbackText: '',
        maxOutputBytes: 4,
        outline: [{ title: 'capitolo' }],
        pages: [],
      })
    ).toThrow(PdfTextWorkerOutputLimitError);
  });
});
