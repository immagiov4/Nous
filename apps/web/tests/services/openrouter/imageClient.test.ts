import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const { requestGeneratedImage } = await import('../../../services/openrouter/imageClient.ts');

describe('requestGeneratedImage', () => {
  beforeEach(() => {
    fetchWithSupabaseAuthMock.mockReset();
  });

  test('requests an authenticated pedagogical image from the backend', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
          mediaType: 'image/png',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const result = await requestGeneratedImage('A focused educational image.');

    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/images/generate',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(JSON.parse(String(fetchWithSupabaseAuthMock.mock.calls[0]?.[1]?.body))).toEqual({
      prompt: 'A focused educational image.',
    });
    expect(result).toEqual({
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      mediaType: 'image/png',
    });
  });

  test('rejects unsafe data URLs returned by the backend', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
          mediaType: 'image/svg+xml',
        }),
        { status: 200 }
      )
    );

    await expect(requestGeneratedImage('A diagram')).rejects.toThrow(
      'Generazione immagine non riuscita. Riprova.'
    );
  });

  test('returns a stable error when the backend rejects generation', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'provider detail' }), { status: 502 })
    );

    await expect(requestGeneratedImage('A scene')).rejects.toThrow(
      'Generazione immagine non riuscita. Riprova.'
    );
  });
});
