import { DEFAULT_OPENAI_IMAGE_MODEL, getResolvedGlobalModelConfig } from '../config/modelConfig.js';
import { isRecord } from '../utils/validation.js';
import { generateCodexAppServerImage } from './codexAppServer.js';
import { getOpenAiJsonHeaders, OPENAI_API_BASE_URL } from './openAiApi.js';
import {
  getOpenRouterJsonHeaders,
  OPENROUTER_API_BASE_URL,
  readOpenRouterErrorDetails,
} from './openRouterApi.js';

export { DEFAULT_IMAGE_MODEL, DEFAULT_OPENAI_IMAGE_MODEL } from '../config/modelConfig.js';

type GeneratedImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

interface GenerateImageRequest {
  model?: string;
  prompt: string;
  provider?: 'codex' | 'openai' | 'openrouter';
}

interface GeneratedImageResult {
  dataUrl: string;
  generationId?: string;
  mediaType: GeneratedImageMediaType;
  usage?: Record<string, unknown>;
}

export interface ImageGenerationModel {
  id: string;
  name: string;
}

const ALLOWED_IMAGE_MEDIA_TYPES = new Set<GeneratedImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_GENERATED_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_GENERATION_TIMEOUT_MS = 90_000;
const SUPPORTED_OPENAI_IMAGE_MODELS = new Set([
  DEFAULT_OPENAI_IMAGE_MODEL,
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
]);

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
  listOpenAiModels(): ImageGenerationModel[] {
    return [...SUPPORTED_OPENAI_IMAGE_MODELS].map(id => ({ id, name: id }));
  }

  async listModels(): Promise<ImageGenerationModel[]> {
    const response = await fetch(`${OPENROUTER_API_BASE_URL}/images/models`, {
      headers: getOpenRouterJsonHeaders(),
    });
    if (!response.ok) {
      throw new Error('Impossibile verificare i modelli immagini disponibili.');
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error('Il catalogo dei modelli immagini non è valido.');
    }

    return payload.data.flatMap(model => {
      if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) {
        return [];
      }

      return [
        { id: model.id.trim(), name: typeof model.name === 'string' ? model.name : model.id },
      ];
    });
  }

  async assertModelSupportsImage(modelId: string): Promise<void> {
    const models = await this.listModels();
    if (!models.some(model => model.id === modelId)) {
      throw new Error('Il modello selezionato non supporta la generazione immagini.');
    }
  }

  assertOpenAiModelSupportsImage(modelId: string): void {
    if (!SUPPORTED_OPENAI_IMAGE_MODELS.has(modelId)) {
      throw new Error('Il modello OpenAI selezionato non supporta la generazione immagini.');
    }
  }

  async generateImage(request: GenerateImageRequest): Promise<GeneratedImageResult> {
    const modelConfig = await getResolvedGlobalModelConfig();
    const requestedProvider = request.provider ?? modelConfig.aiProvider;
    if (requestedProvider === 'codex') {
      const result = await generateCodexAppServerImage({
        model: request.model || modelConfig.codexArtifactModel,
        prompt: request.prompt,
      });
      const imageBase64 = result.startsWith('data:image/png;base64,')
        ? result.slice('data:image/png;base64,'.length)
        : result;
      if (!isValidImageBase64(imageBase64)) {
        throw new Error('Codex non ha restituito un risultato immagine valido.');
      }
      return {
        dataUrl: `data:image/png;base64,${imageBase64}`,
        mediaType: 'image/png',
      };
    }

    const usesOpenAi = requestedProvider === 'openai';
    const model =
      request.model || (usesOpenAi ? modelConfig.openAiImageModel : modelConfig.imageModel);
    const response = await fetch(
      usesOpenAi
        ? `${OPENAI_API_BASE_URL}/images/generations`
        : `${OPENROUTER_API_BASE_URL}/images`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
        headers: usesOpenAi ? getOpenAiJsonHeaders() : getOpenRouterJsonHeaders(),
        body: JSON.stringify(
          usesOpenAi
            ? {
                model,
                n: 1,
                output_format: 'png',
                prompt: request.prompt,
                quality: 'medium',
                size: '1536x1024',
              }
            : {
                aspect_ratio: '16:9',
                model,
                n: 1,
                prompt: request.prompt,
                resolution: '1K',
              }
        ),
      }
    );

    if (!response.ok) {
      const details = await readOpenRouterErrorDetails(response);
      console.warn('[Nous] Image request failed', {
        status: response.status,
        model,
        provider: usesOpenAi ? 'openai' : 'openrouter',
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
    const mediaType = usesOpenAi ? 'image/png' : normalizeImageMediaType(firstImage?.media_type);
    const imageBase64 = firstImage?.b64_json;

    if (!mediaType || !isValidImageBase64(imageBase64)) {
      throw new Error('Il servizio immagini non ha restituito un risultato valido.');
    }

    return {
      dataUrl: `data:${mediaType};base64,${imageBase64}`,
      generationId:
        response.headers.get(usesOpenAi ? 'x-request-id' : 'x-generation-id') || undefined,
      mediaType,
      usage: isRecord(payloadRecord?.usage) ? payloadRecord.usage : undefined,
    };
  }
}

export const imageClient = new ImageClient();
