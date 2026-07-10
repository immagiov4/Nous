import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'https://backend.test',
}));

const { requestSpeechAudio, TtsRequestError } = await import(
  '../../../services/openrouter/ttsClient.ts'
);

beforeEach(() => {
  fetchWithSupabaseAuthMock.mockReset();
});

test('requestSpeechAudio preserves the HTTP status for retry decisions', async () => {
  fetchWithSupabaseAuthMock.mockResolvedValue(
    new Response(JSON.stringify({ error: 'Generazione vocale non riuscita.' }), {
      headers: { 'content-type': 'application/json' },
      status: 502,
    })
  );

  await assert.rejects(
    () =>
      requestSpeechAudio({
        model: 'x-ai/grok-voice-tts-1.0',
        text: 'Ciao.',
        voice: 'Ara',
        speed: 1,
      }),
    (error: unknown) => error instanceof TtsRequestError && error.status === 502
  );
});
