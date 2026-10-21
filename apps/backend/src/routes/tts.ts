// Exposes text-to-speech routes for the backend API.
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
import { type Request, type Response, Router } from 'express';
import * as z from 'zod';
import { getCurrentUser } from '../auth/currentUser.js';
import { getResolvedGlobalModelConfig } from '../config/modelConfig.js';
import { prepareSpeech, synthesizeSpeech } from '../services/speechPreparation.js';
import { DEFAULT_TTS_MODEL, MAX_TTS_TEXT_CHARS, ttsClient } from '../services/ttsClient.js';
import {
  LessonPlaybackStaleError,
  LessonPlaybackTargetError,
} from '../workflows/lessonPlaybackApi.js';

const router = Router();
const speechTargetSchema = z
  .object({ projectId: z.string().trim().min(1), sectionId: z.string().trim().min(1) })
  .strict();
const speechSourceSchema = z
  .object({
    block: LessonPlaybackBlockSchema.optional(),
    target: speechTargetSchema.optional(),
  })
  .refine(source => Boolean(source.block) === Boolean(source.target));
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
        error: 'Il testo è obbligatorio e deve essere una stringa.',
      });
    }

    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const signal = controller.signal;
    const source = speechSourceSchema.safeParse(req.body);
    if (!source.success)
      return res.status(400).json({ success: false, error: 'Richiesta di ascolto non valida.' });
    const { block: sourceBlock, target } = source.data;
    if (!target && text.trim().length > MAX_TTS_TEXT_CHARS)
      return res.status(400).json({
        success: false,
        error: `Testo troppo lungo. Massimo ${MAX_TTS_TEXT_CHARS} caratteri per richiesta.`,
      });
    const blocks = sourceBlock
      ? [sourceBlock]
      : segmentLessonPlayback([{ type: 'markdown', markdown: text }]);
    const prepared = [];
    for (const source of blocks) {
      const { prepared: _clientPrepared, audio: _clientAudio, ...raw } = source;
      const block = { ...raw, audio: [] };
      prepared.push(
        await prepareSpeech({
          userId: getCurrentUser(req).id,
          block,
          target,
          config: modelConfig,
          signal,
        })
      );
    }
    const speech = prepared.map(result => result.block.speech).join(' ');
    const generatedAudio = await synthesizeSpeech({
      text: speech,
      signal,
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
    if (error instanceof LessonPlaybackTargetError)
      return res.status(404).json({ success: false, error: 'Lezione non trovata.' });
    if (error instanceof LessonPlaybackStaleError)
      return res
        .status(409)
        .json({ success: false, error: 'La lezione è cambiata. Riaprila per ascoltarla.' });
    console.error('[TTS Route] Error:', error);
    res.status(502).json({
      success: false,
      error: 'Generazione vocale non riuscita.',
    });
  }
});

export default router;
