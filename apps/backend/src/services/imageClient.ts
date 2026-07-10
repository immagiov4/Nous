import { isRecord } from '../utils/validation.js';
import {
  getOpenRouterJsonHeaders,
  OPENROUTER_API_BASE_URL,
  readOpenRouterErrorDetails,
} from './openRouterApi.js';

export const DEFAULT_IMAGE_MODEL = process.env.MODEL_IMAGE || 'google/gemini-3.1-flash-lite-image';

type GeneratedImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

interface GenerateImageRequest {
  prompt: string;
}

interface GeneratedImageResult {
  dataUrl: string;
  generationId?: string;
  mediaType: GeneratedImageMediaType;
  usage?: Record<string, unknown>;
}

const ALLOWED_IMAGE_MEDIA_TYPES = new Set<GeneratedImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_GENERATED_IMAGE_BYTES = 12 * 1024 * 1024;

const isValidImageBase64 = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length % 4 === 0 &&
  BASE64_PATTERN.test(value) &&
  Buffer.byteLength(value, 'base64') <= MAX_GENERATED_IMAGE_BYTES;

const normalizeImageMediaType = (value: unknown): GeneratedImageMediaType | null =>
  typeof value === 'string' && ALLOWED_IMAGE_MEDIA_TYPES.has(value as GeneratedImageMediaType)
    ? (value as GeneratedImageMediaType)
    : null;

class ImageClient {
  async generateImage(request: GenerateImageRequest): Promise<GeneratedImageResult> {
    const response = await fetch(`${OPENROUTER_API_BASE_URL}/images`, {
      method: 'POST',
      headers: getOpenRouterJsonHeaders(),
      body: JSON.stringify({
        aspect_ratio: '16:9',
        model: DEFAULT_IMAGE_MODEL,
        n: 1,
        prompt: request.prompt,
        resolution: '1K',
      }),
    });

    if (!response.ok) {
      const details = await readOpenRouterErrorDetails(response);
      console.warn('[Nous] OpenRouter image request failed', {
        status: response.status,
        model: DEFAULT_IMAGE_MODEL,
        details,
      });
      throw new Error('Il servizio immagini non ha completato la richiesta. Riprova tra poco.');
    }

    const payload: unknown = await response.json().catch(() => null);
    const payloadRecord = isRecord(payload) ? payload : null;
    const firstImage =
      payloadRecord && Array.isArray(payloadRecord.data) && isRecord(payloadRecord.data[0])
        ? payloadRecord.data[0]
        : null;
    const mediaType = normalizeImageMediaType(firstImage?.media_type);
    const imageBase64 = firstImage?.b64_json;

    if (!mediaType || !isValidImageBase64(imageBase64)) {
      throw new Error('Il servizio immagini non ha restituito un risultato valido.');
    }

    return {
      dataUrl: `data:${mediaType};base64,${imageBase64}`,
      generationId: response.headers.get('x-generation-id') || undefined,
      mediaType,
      usage: isRecord(payloadRecord?.usage) ? payloadRecord.usage : undefined,
    };
  }
}

export const imageClient = new ImageClient();
