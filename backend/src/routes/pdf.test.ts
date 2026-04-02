import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const pdfServiceMocks = vi.hoisted(() => ({
  extractPdfImages: vi.fn(),
  extractPdfText: vi.fn(),
}));

vi.mock('../services/pdfImageExtractor.js', () => ({
  extractPdfImages: pdfServiceMocks.extractPdfImages,
}));

vi.mock('../services/pdfTextExtractor.js', () => ({
  extractPdfText: pdfServiceMocks.extractPdfText,
}));

const { createApp } = await import('../index.js');

describe('POST /api/pdf', () => {
  beforeEach(() => {
    pdfServiceMocks.extractPdfImages.mockReset();
    pdfServiceMocks.extractPdfText.mockReset();
    pdfServiceMocks.extractPdfText.mockResolvedValue({
      text: 'Contenuto PDF',
      parser: 'pdf-parse',
      sourceHash: 'hash-1',
      pageCount: 3,
    });
    pdfServiceMocks.extractPdfImages.mockResolvedValue([
      { id: 'img-1', dataUrl: 'data:image/png;base64,ZmFrZQ==' },
    ]);
  });

  test('validates the PDF data url for text extraction', async () => {
    const response = await request(createApp())
      .post('/api/pdf/extract-text')
      .send({ fileData: 'not-a-pdf' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'A PDF data URL is required.',
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
      textLength: 'Contenuto PDF'.length,
      parser: 'pdf-parse',
      sourceHash: 'hash-1',
      pageCount: 3,
    });
  });

  test('returns extracted images with the requested limit', async () => {
    const response = await request(createApp())
      .post('/api/pdf/extract-images')
      .send({ fileData: 'data:application/pdf;base64,ZmFrZQ==', limit: 12 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      imageCount: 1,
      images: [{ id: 'img-1', dataUrl: 'data:image/png;base64,ZmFrZQ==' }],
    });
    expect(pdfServiceMocks.extractPdfImages).toHaveBeenCalledWith(
      'data:application/pdf;base64,ZmFrZQ==',
      12
    );
  });
});
