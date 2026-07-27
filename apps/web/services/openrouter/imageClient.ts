import {
  type GeneratedRasterMediaType,
  parseGeneratedImageDataUrl,
} from '../../utils/visuals/generatedImage.ts';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';

const IMAGE_REQUEST_TIMEOUT_MS = 180_000;
const IMAGE_GENERATION_ERROR = 'Generazione immagine non riuscita. Riprova.';
const RASTER_REQUEST_ERROR = 'La richiesta dell’immagine raster non è riuscita. Riprova.';
const RASTER_REQUEST_TIMEOUT_ERROR =
  'La richiesta dell’immagine raster ha superato il tempo disponibile. Riprova.';

export interface DurableImageGenerationScope {
  dedupeKey: string;
  projectId: string;
}

interface ImageGenerationResponse {
  dataUrl?: unknown;
  mediaType?: unknown;
}

interface GeneratedImageResult {
  dataUrl: string;
  mediaType: GeneratedRasterMediaType;
}

interface ImageGenerationJobResponse {
  job?: {
    id?: unknown;
    errorCode?: unknown;
    result?: unknown;
    status?: unknown;
  };
}

const parseImageResult = (value: unknown): GeneratedImageResult => {
  const payload = value as ImageGenerationResponse | null;
  const parsedDataUrl = parseGeneratedImageDataUrl(payload?.dataUrl);
  if (!parsedDataUrl || payload?.mediaType !== parsedDataUrl.mediaType) {
    throw new Error(IMAGE_GENERATION_ERROR);
  }
  return { dataUrl: payload.dataUrl as string, mediaType: parsedDataUrl.mediaType };
};

const requestDurableGeneratedImage = async (
  prompt: string,
  scope: DurableImageGenerationScope
): Promise<GeneratedImageResult> => {
  const queuedResponse = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/generation-jobs/images`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scope, prompt }),
    }
  );
  if (!queuedResponse.ok) throw new Error(RASTER_REQUEST_ERROR);
  let payload = (await queuedResponse.json().catch(() => ({}))) as ImageGenerationJobResponse;
  if (payload.job?.status !== 'completed') {
    if (payload.job?.status === 'failed') {
      throw new Error(
        payload.job.errorCode === 'generation_timeout'
          ? RASTER_REQUEST_TIMEOUT_ERROR
          : RASTER_REQUEST_ERROR
      );
    }
    if (typeof payload.job?.id !== 'string') {
      throw new TypeError(RASTER_REQUEST_ERROR);
    }
    const completedResponse = await fetchWithSupabaseAuth(
      `${getBackendUrl()}/api/generation-jobs/${encodeURIComponent(payload.job.id)}/wait`
    );
    if (!completedResponse.ok) throw new Error(RASTER_REQUEST_ERROR);
    payload = (await completedResponse.json().catch(() => ({}))) as ImageGenerationJobResponse;
  }
  if (payload.job?.status !== 'completed') {
    throw new Error(
      payload.job?.errorCode === 'generation_timeout'
        ? RASTER_REQUEST_TIMEOUT_ERROR
        : RASTER_REQUEST_ERROR
    );
  }
  return parseImageResult(payload.job.result);
};

export const requestGeneratedImage = async (
  prompt: string,
  durableScope?: DurableImageGenerationScope
): Promise<GeneratedImageResult> => {
  if (durableScope) return requestDurableGeneratedImage(prompt, durableScope);
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/images/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(IMAGE_GENERATION_ERROR);
  }

  return parseImageResult(await response.json().catch(() => ({})));
};
