import { type Request, type Response, Router } from 'express';

import { imageClient } from '../services/imageClient.js';

const router = Router();
const MAX_IMAGE_PROMPT_CHARS = 12_000;

router.post('/generate', async (req: Request, res: Response) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    return res.status(400).json({
      success: false,
      error: 'Descrizione immagine non valida.',
    });
  }

  try {
    const image = await imageClient.generateImage({ prompt });
    if (image.generationId) {
      res.set('X-Generation-Id', image.generationId);
    }

    return res.json({
      success: true,
      dataUrl: image.dataUrl,
      mediaType: image.mediaType,
      usage: image.usage,
    });
  } catch (error) {
    console.error('[Images Route] Error:', error);
    return res.status(502).json({
      success: false,
      error: 'Generazione immagine non riuscita.',
    });
  }
});

export default router;
