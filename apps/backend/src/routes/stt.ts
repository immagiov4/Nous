import { type Request, type Response, Router } from 'express';

import {
  type SttAudioFormat,
  SUPPORTED_STT_AUDIO_FORMATS,
  sttClient,
} from '../services/sttClient.js';

const router = Router();
const MAX_STT_AUDIO_BYTES = 12 * 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LANGUAGE_CODE_PATTERN = /^[a-z]{2}$/;
const supportedFormats = new Set<string>(SUPPORTED_STT_AUDIO_FORMATS);

const isValidBase64 = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length % 4 === 0 &&
  BASE64_PATTERN.test(value);

const isSupportedFormat = (value: unknown): value is SttAudioFormat =>
  typeof value === 'string' && supportedFormats.has(value);

router.post('/', async (req: Request, res: Response) => {
  const { data, format, language } = req.body;

  if (!isValidBase64(data)) {
    return res.status(400).json({
      success: false,
      error: 'Audio non valido.',
    });
  }

  if (!isSupportedFormat(format)) {
    return res.status(400).json({
      success: false,
      error: 'Formato audio non supportato.',
    });
  }

  if (language !== undefined && !LANGUAGE_CODE_PATTERN.test(language)) {
    return res.status(400).json({
      success: false,
      error: 'Codice lingua non valido.',
    });
  }

  if (Buffer.byteLength(data, 'base64') > MAX_STT_AUDIO_BYTES) {
    return res.status(413).json({
      success: false,
      error: 'Registrazione troppo lunga.',
    });
  }

  try {
    const transcription = await sttClient.transcribeAudio({
      data,
      format,
      language,
    });

    if (transcription.generationId) {
      res.set('X-Generation-Id', transcription.generationId);
    }

    return res.json({
      success: true,
      text: transcription.text,
      usage: transcription.usage,
    });
  } catch (error) {
    console.error('[STT Route] Error:', error);
    return res.status(502).json({
      success: false,
      error: 'Trascrizione non riuscita.',
    });
  }
});

export default router;
