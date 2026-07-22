import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const { requestSpeechTranscription } = await import('../../../services/openrouter/sttClient.ts');

describe('requestSpeechTranscription', () => {
  beforeEach(() => {
    fetchWithSupabaseAuthMock.mockReset();
  });

  test('sends raw browser audio as base64 to the authenticated STT route', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          text: 'Testo trascritto.',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const audio = new Blob(['fake audio'], { type: 'audio/webm' });
    const text = await requestSpeechTranscription(audio, 'webm', 'it');

    expect(text).toBe('Testo trascritto.');
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/stt',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(JSON.parse(String(fetchWithSupabaseAuthMock.mock.calls[0]?.[1]?.body))).toEqual({
      data: 'ZmFrZSBhdWRpbw==',
      format: 'webm',
      language: 'it',
    });
  });

  test('returns a stable error without retrying a rejected backend request', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'provider detail' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(requestSpeechTranscription(new Blob(['audio']), 'webm', 'it')).rejects.toThrow(
      'Trascrizione non riuscita. Riprova.'
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledTimes(1);
  });
});
