import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_STT_MODEL, sttClient } from '../../src/services/sttClient.js';

const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

describe('OpenRouter STT client', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_OPENROUTER_API_KEY === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
    }
  });

  test('sends browser audio to the dedicated transcription endpoint', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            text: 'Testo trascritto.',
            usage: {
              cost: 0.00005,
              seconds: 2,
            },
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-Generation-Id': 'generation-1',
            },
          }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sttClient.transcribeAudio({
      data: 'ZmFrZS1hdWRpbw==',
      format: 'webm',
      language: 'it',
    });

    expect(DEFAULT_STT_MODEL).toBe('nvidia/parakeet-tdt-0.6b-v3');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-openrouter-key',
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      input_audio: {
        data: 'ZmFrZS1hdWRpbw==',
        format: 'webm',
      },
      language: 'it',
      model: 'nvidia/parakeet-tdt-0.6b-v3',
    });
    expect(result).toEqual({
      text: 'Testo trascritto.',
      usage: {
        cost: 0.00005,
        seconds: 2,
      },
      generationId: 'generation-1',
    });
  });

  test('rejects successful responses without transcription text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ usage: { seconds: 1 } }), { status: 200 }))
    );

    await expect(
      sttClient.transcribeAudio({
        data: 'ZmFrZS1hdWRpbw==',
        format: 'webm',
      })
    ).rejects.toThrow('Il servizio STT non ha restituito una trascrizione valida.');
  });

  test('hides provider failures behind a stable service error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'provider internal detail' } }), {
            status: 503,
          })
      )
    );

    await expect(
      sttClient.transcribeAudio({
        data: 'ZmFrZS1hdWRpbw==',
        format: 'webm',
      })
    ).rejects.toThrow('Il servizio STT non ha completato la richiesta. Riprova tra poco.');
  });
});
