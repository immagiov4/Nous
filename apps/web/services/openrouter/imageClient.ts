import {
  type GeneratedRasterMediaType,
  parseGeneratedImageDataUrl,
} from '../../utils/visuals/generatedImage.ts';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';

const IMAGE_REQUEST_TIMEOUT_MS = 180_000;
const IMAGE_GENERATION_ERROR = 'Generazione immagine non riuscita. Riprova.';

interface ImageGenerationResponse {
  dataUrl?: unknown;
  mediaType?: unknown;
}

interface GeneratedImageResult {
  dataUrl: string;
  mediaType: GeneratedRasterMediaType;
}

export const requestGeneratedImage = async (prompt: string): Promise<GeneratedImageResult> => {
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/images/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(IMAGE_GENERATION_ERROR);
  }

  const payload: ImageGenerationResponse = await response.json().catch(() => ({}));
  const parsedDataUrl = parseGeneratedImageDataUrl(payload.dataUrl);
  if (!parsedDataUrl || payload.mediaType !== parsedDataUrl.mediaType) {
    throw new Error(IMAGE_GENERATION_ERROR);
  }

  return {
    dataUrl: payload.dataUrl as string,
    mediaType: parsedDataUrl.mediaType,
  };
};
