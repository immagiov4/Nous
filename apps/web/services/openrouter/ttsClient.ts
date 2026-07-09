import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';
import type { TtsModelsResponse, TtsStatusResponse, TtsVoiceDescriptor } from './types.ts';

const TTS_DISCOVERY_REQUEST_TIMEOUT_MS = 5_000;

interface GenerateSpeechPayload {
  model: string;
  text: string;
  voice: string;
  speed: number;
}

export interface SpeechAudioResponse {
  audioBuffer: ArrayBuffer;
  contentType: string;
}

interface TtsErrorResponse {
  error?: string;
}

interface TtsVoicesResponse {
  voices?: TtsVoiceDescriptor[];
}

export const requestSpeechAudio = async (
  payload: GenerateSpeechPayload
): Promise<SpeechAudioResponse> => {
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = (await response
      .json()
      .catch(() => ({ error: 'Unknown error' }))) as TtsErrorResponse;
    throw new Error(`TTS API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
  }

  return {
    audioBuffer: await response.arrayBuffer(),
    contentType: response.headers.get('content-type') || 'audio/mpeg',
  };
};

export const requestTtsStatus = async (): Promise<TtsStatusResponse> => {
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/status`, {
    method: 'GET',
    signal: AbortSignal.timeout(TTS_DISCOVERY_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Status check failed: ${response.status}`);
  }

  return (await response.json()) as TtsStatusResponse;
};

export const requestTtsVoices = async (): Promise<TtsVoiceDescriptor[]> => {
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/voices`, {
    method: 'GET',
    signal: AbortSignal.timeout(TTS_DISCOVERY_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as TtsVoicesResponse;
  return data.voices || [];
};

export const requestTtsModels = async (): Promise<TtsModelsResponse> => {
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/tts/models`, {
    method: 'GET',
    signal: AbortSignal.timeout(TTS_DISCOVERY_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`TTS model discovery failed: ${response.status}`);
  }

  return (await response.json()) as TtsModelsResponse;
};
