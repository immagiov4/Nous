export type AiProviderPreference = 'codex' | 'openai' | 'openrouter';

export const AI_PROVIDER_HEADER = 'X-Nous-AI-Provider';
const AI_PROVIDER_STORAGE_KEY = 'nous.ai-provider';
const AI_PROVIDERS = new Set<AiProviderPreference>(['codex', 'openai', 'openrouter']);

export const getAiProviderPreference = (): AiProviderPreference | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const value = window.localStorage.getItem(AI_PROVIDER_STORAGE_KEY);
  return value && AI_PROVIDERS.has(value as AiProviderPreference)
    ? (value as AiProviderPreference)
    : null;
};

export const setAiProviderPreference = (provider: AiProviderPreference | null): void => {
  if (typeof window === 'undefined') {
    return;
  }
  if (provider) {
    window.localStorage.setItem(AI_PROVIDER_STORAGE_KEY, provider);
  } else {
    window.localStorage.removeItem(AI_PROVIDER_STORAGE_KEY);
  }
};

export const addAiProviderPreferenceHeader = (headers?: HeadersInit): HeadersInit => {
  const provider = getAiProviderPreference();
  if (!provider) {
    return headers || {};
  }
  const resolvedHeaders = new Headers(headers);
  resolvedHeaders.set(AI_PROVIDER_HEADER, provider);
  return resolvedHeaders;
};
