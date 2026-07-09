import { isRecord } from '../utils/validation.js';
import {
  getOpenRouterJsonHeaders,
  OPENROUTER_API_BASE_URL,
  readOpenRouterErrorDetails,
} from './openRouterAudioApi.js';

export const DEFAULT_STT_MODEL = process.env.MODEL_STT || 'nvidia/parakeet-tdt-0.6b-v3';
export const SUPPORTED_STT_AUDIO_FORMATS = [
  'aac',
  'flac',
  'm4a',
  'mp3',
  'ogg',
  'wav',
  'webm',
] as const;

export type SttAudioFormat = (typeof SUPPORTED_STT_AUDIO_FORMATS)[number];

interface TranscribeAudioRequest {
  data: string;
  format: SttAudioFormat;
  language?: string;
}

interface TranscriptionResult {
  generationId?: string;
  text: string;
  usage?: Record<string, unknown>;
}

class STTClient {
  async transcribeAudio(request: TranscribeAudioRequest): Promise<TranscriptionResult> {
    const response = await fetch(`${OPENROUTER_API_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: getOpenRouterJsonHeaders(),
      body: JSON.stringify({
        input_audio: {
          data: request.data,
          format: request.format,
        },
        language: request.language,
        model: DEFAULT_STT_MODEL,
      }),
    });

    if (!response.ok) {
      const details = await readOpenRouterErrorDetails(response);
      console.warn('[Nous] OpenRouter STT request failed', {
        status: response.status,
        model: DEFAULT_STT_MODEL,
        details,
      });
      throw new Error('Il servizio STT non ha completato la richiesta. Riprova tra poco.');
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || typeof payload.text !== 'string' || !payload.text.trim()) {
      throw new Error('Il servizio STT non ha restituito una trascrizione valida.');
    }

    return {
      text: payload.text.trim(),
      usage: isRecord(payload.usage) ? payload.usage : undefined,
      generationId: response.headers.get('x-generation-id') || undefined,
    };
  }
}

export const sttClient = new STTClient();
