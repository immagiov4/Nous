// Exposes text-to-speech routes for the backend API.
import { type Request, type Response, Router } from 'express';

import { getResolvedGlobalModelConfig } from '../config/modelConfig.js';
import { DEFAULT_TTS_MODEL, ttsClient } from '../services/ttsClient.js';

const router = Router();
const MAX_TTS_TEXT_CHARS = 10_000;
const TTS_AUDIO_CACHE_MAX_AGE_SECONDS = 3_600;

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
      error: 'Impossibile recuperare i modelli TTS.',
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
    const { text, speed, voice } = req.body;
    const modelConfig = await getResolvedGlobalModelConfig();

    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Il testo e obbligatorio e deve essere una stringa.',
      });
    }

    const normalizedText = text.replaceAll(/\s+/g, ' ').trim();

    if (normalizedText.length > MAX_TTS_TEXT_CHARS) {
      return res.status(400).json({
        success: false,
        error: `Testo troppo lungo. Massimo ${MAX_TTS_TEXT_CHARS} caratteri per richiesta.`,
      });
    }

    const generatedAudio = await ttsClient.generateSpeech({
      text: normalizedText,
      model: modelConfig.ttsModel,
      voice: typeof voice === 'string' && voice.trim() ? voice.trim() : modelConfig.ttsVoice,
      speed,
    });

    res.set({
      'Content-Type': generatedAudio.contentType,
      'Content-Length': generatedAudio.audioBuffer.byteLength.toString(),
      'Cache-Control': `public, max-age=${TTS_AUDIO_CACHE_MAX_AGE_SECONDS}`,
    });

    if (generatedAudio.generationId) {
      res.set('X-Generation-Id', generatedAudio.generationId);
    }

    res.send(Buffer.from(generatedAudio.audioBuffer));
  } catch (error) {
    console.error('[TTS Route] Error:', error);
    res.status(502).json({
      success: false,
      error: 'Generazione vocale non riuscita.',
    });
  }
});

export default router;
