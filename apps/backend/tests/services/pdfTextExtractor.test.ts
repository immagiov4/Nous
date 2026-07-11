import { describe, expect, test } from 'vitest';
import { buildDeterministicPdfOutline } from '../../src/services/pdfTextExtractor.js';

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
