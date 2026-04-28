import { Router } from 'express';
import { extractPdfImages } from '../services/pdfImageExtractor.js';
import { extractPdfText } from '../services/pdfTextExtractor.js';
import { isPdfDataUrl, PDF_DATA_URL_REQUIRED_MESSAGE } from '../utils/pdfDataUrl.js';

const router = Router();
const DEFAULT_PDF_IMAGE_LIMIT = 20;
const MAX_PDF_IMAGE_LIMIT = 80;

const readPdfImageLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PDF_IMAGE_LIMIT;
  }

  return Math.max(1, Math.min(MAX_PDF_IMAGE_LIMIT, Math.trunc(value)));
};

router.post('/extract-text', async (req, res) => {
  try {
    const fileData = typeof req.body?.fileData === 'string' ? req.body.fileData : '';

    if (!isPdfDataUrl(fileData)) {
      return res.status(400).json({
        success: false,
        error: PDF_DATA_URL_REQUIRED_MESSAGE,
      });
    }

    const result = await extractPdfText(fileData);
    return res.json({
      success: true,
      text: result.text,
      textLength: result.text.length,
      parser: result.parser,
      sourceHash: result.sourceHash,
      pageCount: result.pageCount,
      pages: result.pages,
      parserFallbackReason: result.parserFallbackReason,
      qualityWarning: result.qualityWarning,
      usedFallbackParser: result.usedFallbackParser,
    });
  } catch (error) {
    console.error('[Backend] PDF text extraction failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Estrazione del testo dal PDF non riuscita.',
    });
  }
});

router.post('/extract-images', async (req, res) => {
  try {
    const fileData = typeof req.body?.fileData === 'string' ? req.body.fileData : '';
    const limit = readPdfImageLimit(req.body?.limit);
    const partialPages = Array.isArray(req.body?.partialPages)
      ? req.body.partialPages.filter(
          (page: unknown): page is number =>
            typeof page === 'number' && Number.isInteger(page) && page > 0
        )
      : undefined;

    if (!isPdfDataUrl(fileData)) {
      return res.status(400).json({
        success: false,
        error: PDF_DATA_URL_REQUIRED_MESSAGE,
      });
    }

    const images = await extractPdfImages(fileData, limit, partialPages);
    return res.json({
      success: true,
      imageCount: images.length,
      images,
    });
  } catch (error) {
    console.error('[Backend] PDF image extraction failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Estrazione delle immagini dal PDF non riuscita.',
    });
  }
});

export default router;
