import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';

const BASE64_CHUNK_BYTES = 24_576;
const STT_REQUEST_TIMEOUT_MS = 70_000;

export type SttAudioFormat = 'aac' | 'flac' | 'm4a' | 'mp3' | 'ogg' | 'wav' | 'webm';

interface SttResponse {
  text?: unknown;
}

const encodeAudioAsBase64 = async (audio: Blob): Promise<string> => {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }

  return btoa(binary);
};

export const requestSpeechTranscription = async (
  audio: Blob,
  format: SttAudioFormat,
  language = 'it'
): Promise<string> => {
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/stt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: await encodeAudioAsBase64(audio),
      format,
      language,
    }),
    signal: AbortSignal.timeout(STT_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error('Trascrizione non riuscita. Riprova.');
  }

  const payload: SttResponse = await response.json().catch(() => ({}));
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('Trascrizione non riuscita. Riprova.');
  }

  return payload.text.trim();
};
