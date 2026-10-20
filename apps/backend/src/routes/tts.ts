// Exposes text-to-speech routes for the backend API.
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
import { type Request, type Response, Router } from 'express';
import { getCurrentUser } from '../auth/currentUser.js';
import { getResolvedGlobalModelConfig } from '../config/modelConfig.js';
import { prepareSpeech, synthesizeSpeech } from '../services/speechPreparation.js';
import { DEFAULT_TTS_MODEL, MAX_TTS_TEXT_CHARS, ttsClient } from '../services/ttsClient.js';

const router = Router();
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
    const { text, speed, voice, block: sourceBlock } = req.body;
    const modelConfig = await getResolvedGlobalModelConfig();

    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Il testo è obbligatorio e deve essere una stringa.',
      });
    }

    const normalizedText = text.trim();

    if (normalizedText.length > MAX_TTS_TEXT_CHARS) {
      return res.status(400).json({
        success: false,
        error: `Testo troppo lungo. Massimo ${MAX_TTS_TEXT_CHARS} caratteri per richiesta.`,
      });
    }

    const signal = new AbortController().signal;
    const parsedBlock =
      sourceBlock === undefined ? undefined : LessonPlaybackBlockSchema.safeParse(sourceBlock);
    if (parsedBlock && !parsedBlock.success) {
      return res.status(400).json({ success: false, error: 'Richiesta di ascolto non valida.' });
    }
    const blocks = parsedBlock?.success
      ? [parsedBlock.data]
      : segmentLessonPlayback([{ type: 'markdown', markdown: text }]);
    const prepared = [];
    for (const source of blocks) {
      const { prepared: _clientPrepared, audio: _clientAudio, ...raw } = source;
      const block = { ...raw, audio: [] };
      prepared.push(
        await prepareSpeech({ userId: getCurrentUser(req).id, block, config: modelConfig, signal })
      );
    }
    const speech = prepared.map(result => result.block.speech).join(' ');
    if (speech.length > MAX_TTS_TEXT_CHARS) {
      return res.status(400).json({
        success: false,
        error: `Testo troppo lungo. Massimo ${MAX_TTS_TEXT_CHARS} caratteri per richiesta.`,
      });
    }
    const generatedAudio = await synthesizeSpeech({
      text: speech,
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
