import { type Request, type Response, Router } from 'express';

import { DEFAULT_TTS_MODEL, ttsClient } from '../services/ttsClient.js';

const router = Router();

/**
 * GET /api/tts/models
 * Get OpenRouter TTS-capable models
 */
router.get('/models', async (_req: Request, res: Response) => {
  try {
    const models = await ttsClient.listModels();
    res.json({
      success: true,
      defaultModel: DEFAULT_TTS_MODEL,
      models,
    });
  } catch (error) {
    console.error('[TTS Models Route] Error:', error);
    res.status(502).json({
      success: false,
      error: 'Failed to get TTS models',
    });
  }
});

/**
 * POST /api/tts
 * Generate speech from text
 *
 * Body: { text: string, model?: string, voice?: string, speed?: number }
 * Returns: audio binary data
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { text, model, voice, speed } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Text is required and must be a string',
      });
    }

    if (text.length > 10000) {
      return res.status(400).json({
        success: false,
        error: 'Text too long. Maximum 10000 characters per request.',
      });
    }

    const generatedAudio = await ttsClient.generateSpeech({ text, model, voice, speed });

    res.set({
      'Content-Type': generatedAudio.contentType,
      'Content-Length': generatedAudio.audioBuffer.byteLength.toString(),
      'Cache-Control': 'public, max-age=3600',
    });

    if (generatedAudio.generationId) {
      res.set('X-Generation-Id', generatedAudio.generationId);
    }

    res.send(Buffer.from(generatedAudio.audioBuffer));
  } catch (error) {
    console.error('[TTS Route] Error:', error);
    res.status(502).json({
      success: false,
      error: 'Failed to generate speech',
    });
  }
});

export default router;
