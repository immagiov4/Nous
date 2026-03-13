import { Router } from 'express';
import { extractPdfImages } from '../services/pdfImageExtractor.js';

const router = Router();

router.post('/extract-images', async (req, res) => {
  try {
    const fileData = typeof req.body?.fileData === 'string' ? req.body.fileData : '';
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : 20;

    if (!fileData.startsWith('data:application/pdf;base64,')) {
      return res.status(400).json({
        success: false,
        error: 'A PDF data URL is required.',
      });
    }

    const images = await extractPdfImages(fileData, limit);
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
