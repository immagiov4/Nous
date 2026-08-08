import { requireOpenRouterApiKey } from '../config/chatConfig.js';
import { isRecord } from '../utils/validation.js';

const OPENROUTER_MODEL_URL = 'https://openrouter.ai/api/v1/model';
const imageSupportByModel = new Map<string, boolean>();

export const openRouterModelSupportsImages = async (model: string): Promise<boolean> => {
  const cachedSupport = imageSupportByModel.get(model);
  if (cachedSupport !== undefined) return cachedSupport;

  try {
    const response = await fetch(`${OPENROUTER_MODEL_URL}/${model}`, {
      headers: { Authorization: `Bearer ${requireOpenRouterApiKey()}` },
    });
    if (!response.ok) return false;

    const payload = (await response.json()) as unknown;
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
    const architecture = data && isRecord(data.architecture) ? data.architecture : null;
    const inputModalities = architecture?.input_modalities;
    const supportsImages = Array.isArray(inputModalities) && inputModalities.includes('image');
    imageSupportByModel.set(model, supportsImages);
    return supportsImages;
  } catch (error) {
    console.warn('[Nous][OpenRouter] Model capabilities unavailable; using text-only fallback.', {
      error,
      model,
    });
    return false;
  }
};
