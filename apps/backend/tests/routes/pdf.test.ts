import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const pdfServiceMocks = vi.hoisted(() => ({
  extractPdfImages: vi.fn(),
  extractPdfText: vi.fn(),
}));

vi.mock('../../src/services/pdfImageExtractor.js', () => ({
  extractPdfImages: pdfServiceMocks.extractPdfImages,
}));

vi.mock('../../src/services/pdfTextExtractor.js', () => ({
  extractPdfText: pdfServiceMocks.extractPdfText,
}));

const { createApp } = await import('../../src/index.js');

describe('POST /api/pdf', () => {
  beforeEach(() => {
    pdfServiceMocks.extractPdfImages.mockReset();
    pdfServiceMocks.extractPdfText.mockReset();
    pdfServiceMocks.extractPdfText.mockResolvedValue({
      text: 'Contenuto PDF',
      pages: [
        { pageNumber: 1, text: 'Pagina 1' },
        { pageNumber: 2, text: 'Pagina 2' },
        { pageNumber: 3, text: 'Pagina 3' },
      ],
      parser: 'pdf-parse',
      sourceHash: 'hash-1',
      pageCount: 3,
      usedFallbackParser: true,
      outline: [{ id: 'outline-1', title: 'Capitolo 1', level: 1, page: 2, children: [] }],
      outlineOrigin: 'native',
      qualityWarning:
        'Estrazione testo eseguita con parser di fallback; qualita e impaginazione potrebbero essere meno fedeli.',
    });
    pdfServiceMocks.extractPdfImages.mockResolvedValue([
      { id: 'img-1', dataUrl: 'data:image/png;base64,ZmFrZQ==', pageNumber: 4 },
    ]);
  });

  test('validates the PDF data url for text extraction', async () => {
    const response = await request(createApp())
      .post('/api/pdf/extract-text')
      .send({ fileData: 'not-a-pdf' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'E richiesto un data URL PDF valido.',
    });
  });

  test('returns extracted text metadata', async () => {
    const response = await request(createApp())
      .post('/api/pdf/extract-text')
      .send({ fileData: 'data:application/pdf;base64,ZmFrZQ==' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      text: 'Contenuto PDF',
      pages: [
        { pageNumber: 1, text: 'Pagina 1' },
        { pageNumber: 2, text: 'Pagina 2' },
        { pageNumber: 3, text: 'Pagina 3' },
      ],
      textLength: 'Contenuto PDF'.length,
      parser: 'pdf-parse',
      sourceHash: 'hash-1',
      pageCount: 3,
      parserFallbackReason: undefined,
      qualityWarning:
        'Estrazione testo eseguita con parser di fallback; qualita e impaginazione potrebbero essere meno fedeli.',
      usedFallbackParser: true,
      outline: [{ id: 'outline-1', title: 'Capitolo 1', level: 1, page: 2, children: [] }],
      outlineOrigin: 'native',
    });
  });

  test('returns extracted images with the requested limit', async () => {
    const response = await request(createApp())
      .post('/api/pdf/extract-images')
      .send({
        fileData: 'data:application/pdf;base64,ZmFrZQ==',
        limit: 12,
        partialPages: [3, 4, 5],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      imageCount: 1,
      images: [{ id: 'img-1', dataUrl: 'data:image/png;base64,ZmFrZQ==', pageNumber: 4 }],
    });
    expect(pdfServiceMocks.extractPdfImages).toHaveBeenCalledWith(
      'data:application/pdf;base64,ZmFrZQ==',
      12,
      [3, 4, 5]
    );
  });
});
