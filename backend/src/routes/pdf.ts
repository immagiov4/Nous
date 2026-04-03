import { Router } from 'express';
import { extractPdfImages } from '../services/pdfImageExtractor.js';
import { extractPdfText } from '../services/pdfTextExtractor.js';

const router = Router();

router.post('/extract-text', async (req, res) => {
  try {
    const fileData = typeof req.body?.fileData === 'string' ? req.body.fileData : '';

    if (!fileData.startsWith('data:application/pdf;base64,')) {
      return res.status(400).json({
        success: false,
        error: 'A PDF data URL is required.',
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
    });
  } catch (error) {
    console.error('[Backend] PDF text extraction failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to extract text from PDF.',
    });
  }
});

router.post('/extract-images', async (req, res) => {
  try {
    const fileData = typeof req.body?.fileData === 'string' ? req.body.fileData : '';
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : 20;
    const partialPages = Array.isArray(req.body?.partialPages)
      ? req.body.partialPages.filter(
          (page: unknown): page is number =>
            typeof page === 'number' && Number.isInteger(page) && page > 0
        )
      : undefined;

    if (!fileData.startsWith('data:application/pdf;base64,')) {
      return res.status(400).json({
        success: false,
        error: 'A PDF data URL is required.',
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
      error: 'Failed to extract images from PDF.',
    });
  }
});

export default router;
