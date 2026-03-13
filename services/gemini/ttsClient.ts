import { getBackendUrl } from './config';
import type { TtsStatusResponse, TtsVoiceDescriptor } from './types';

interface GenerateSpeechPayload {
  text: string;
  voice: string;
  speed: number;
}

interface TtsErrorResponse {
  error?: string;
}

interface TtsVoicesResponse {
  voices?: TtsVoiceDescriptor[];
}

export const requestSpeechAudio = async (payload: GenerateSpeechPayload): Promise<ArrayBuffer> => {
  const response = await fetch(`${getBackendUrl()}/api/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({ error: 'Unknown error' }))) as TtsErrorResponse;
    throw new Error(`TTS API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
  }

  return response.arrayBuffer();
};

export const requestTtsStatus = async (): Promise<TtsStatusResponse> => {
  const response = await fetch(`${getBackendUrl()}/api/status`, {
    method: 'GET',
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Status check failed: ${response.status}`);
  }

  return (await response.json()) as TtsStatusResponse;
};

export const requestTtsVoices = async (): Promise<TtsVoiceDescriptor[]> => {
  const response = await fetch(`${getBackendUrl()}/api/voices`, {
    method: 'GET',
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as TtsVoicesResponse;
  return data.voices || [];
};
