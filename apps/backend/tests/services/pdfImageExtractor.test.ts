import { PDFParse } from 'pdf-parse';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildLocalImageTextContext,
  extractPdfImages,
  isPdfImageTooSmallForStandaloneFigure,
  PdfImageExtractionError,
} from '../../src/services/pdfImageExtractor.js';

const buildMinimalPdfDataUrl = (): string => {
  const header = '%PDF-1.4\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 43 >>\nstream\nBT /F1 12 Tf 30 100 Td (PDF smoke) Tj ET\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const offsets: number[] = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return `data:application/pdf;base64,${Buffer.from(body).toString('base64')}`;
};

test('loads the production PDF.js path and extracts a real minimal PDF', async () => {
  await expect(extractPdfImages(buildMinimalPdfDataUrl(), 1, [1])).resolves.toEqual({
    failedPages: [],
    images: [],
  });
});

describe('PDF page extraction diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns sorted failed-page diagnostics when another requested page succeeds', async () => {
    vi.spyOn(PDFParse.prototype, 'getImage')
      .mockRejectedValueOnce(new Error('page 1 failed'))
      .mockResolvedValueOnce({ pages: [{ images: [], pageNumber: 2 }] } as never);
    vi.spyOn(PDFParse.prototype, 'destroy').mockResolvedValue(undefined);

    await expect(extractPdfImages(buildMinimalPdfDataUrl(), 1, [2, 1, 2])).resolves.toEqual({
      failedPages: [1],
      images: [],
    });
  });

  test('rejects instead of reporting an empty success when every requested page fails', async () => {
    vi.spyOn(PDFParse.prototype, 'getImage').mockRejectedValue(new Error('page failed'));
    vi.spyOn(PDFParse.prototype, 'destroy').mockResolvedValue(undefined);

    const failure = await extractPdfImages(buildMinimalPdfDataUrl(), 1, [2, 1]).catch(
      error => error
    );

    expect(failure).toBeInstanceOf(PdfImageExtractionError);
    expect(failure).toMatchObject({
      code: 'pdf_image_extraction_failed',
      failedPages: [1, 2],
    });
  });
});

describe('buildLocalImageTextContext', () => {
  test('keeps only the nearest lines above and below the image rect', () => {
    const lines = [
      { text: 'above-1', top: 10, bottom: 18, centerY: 14 },
      { text: 'above-2', top: 20, bottom: 28, centerY: 24 },
      { text: 'above-3', top: 30, bottom: 38, centerY: 34 },
      { text: 'above-4', top: 40, bottom: 48, centerY: 44 },
      { text: 'above-5', top: 50, bottom: 58, centerY: 54 },
      { text: 'above-6', top: 60, bottom: 68, centerY: 64 },
      { text: 'inside-1', top: 110, bottom: 118, centerY: 114 },
      { text: 'inside-2', top: 140, bottom: 148, centerY: 144 },
      { text: 'below-1', top: 210, bottom: 218, centerY: 214 },
      { text: 'below-2', top: 220, bottom: 228, centerY: 224 },
      { text: 'below-3', top: 230, bottom: 238, centerY: 234 },
      { text: 'below-4', top: 240, bottom: 248, centerY: 244 },
      { text: 'below-5', top: 250, bottom: 258, centerY: 254 },
      { text: 'below-6', top: 260, bottom: 268, centerY: 264 },
    ];

    const context = buildLocalImageTextContext(lines, {
      left: 50,
      top: 100,
      right: 180,
      bottom: 200,
    });

    expect(context.textBefore).toBe('above-2\nabove-3\nabove-4\nabove-5\nabove-6');
    expect(context.textCurrent).toBe('inside-1\ninside-2');
    expect(context.textAfter).toBe('below-1\nbelow-2\nbelow-3\nbelow-4\nbelow-5');
  });
});

describe('isPdfImageTooSmallForStandaloneFigure', () => {
  test('rejects small inline images that would become oversized when rendered as standalone figures', () => {
    expect(
      isPdfImageTooSmallForStandaloneFigure({
        isInline: true,
        intrinsicHeight: 64,
        intrinsicWidth: 88,
        renderedHeight: 64,
        renderedWidth: 88,
      })
    ).toBe(true);
  });

  test('rejects small non-inline icons too', () => {
    expect(
      isPdfImageTooSmallForStandaloneFigure({
        isInline: false,
        intrinsicHeight: 84,
        intrinsicWidth: 96,
        renderedHeight: 84,
        renderedWidth: 96,
      })
    ).toBe(true);
  });

  test('rejects low-resolution images that are heavily upscaled in the PDF layout', () => {
    expect(
      isPdfImageTooSmallForStandaloneFigure({
        isInline: false,
        intrinsicHeight: 160,
        intrinsicWidth: 220,
        renderedHeight: 300,
        renderedWidth: 420,
      })
    ).toBe(true);
  });

  test('keeps normal figures and larger inline images', () => {
    expect(
      isPdfImageTooSmallForStandaloneFigure({
        isInline: true,
        intrinsicHeight: 240,
        intrinsicWidth: 320,
        renderedHeight: 180,
        renderedWidth: 220,
      })
    ).toBe(false);
    expect(
      isPdfImageTooSmallForStandaloneFigure({
        isInline: false,
        intrinsicHeight: 200,
        intrinsicWidth: 300,
        renderedHeight: 110,
        renderedWidth: 180,
      })
    ).toBe(false);
    expect(
      isPdfImageTooSmallForStandaloneFigure({
        isInline: false,
        intrinsicHeight: 240,
        intrinsicWidth: 360,
      })
    ).toBe(false);
  });
});
