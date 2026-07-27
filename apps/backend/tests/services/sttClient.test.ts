import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_STT_FALLBACK_MODEL,
  DEFAULT_STT_MODEL,
  STT_ATTEMPT_TIMEOUTS_MS,
  sttClient,
} from '../../src/services/sttClient.js';

const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

describe('OpenRouter STT client', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(STT_ATTEMPT_TIMEOUTS_MS).toEqual([20_000, 25_000, 30_000]);
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
    ).rejects.toThrow('Il servizio STT non ha completato la richiesta. Riprova tra poco.');
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

  test('uses progressive timeouts and the stable fallback only for the third attempt', async () => {
    const timeoutMock = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'Fallback riuscito.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sttClient.transcribeAudio({
      data: 'ZmFrZS1hdWRpbw==',
      format: 'webm',
      language: 'it',
    });

    expect(DEFAULT_STT_FALLBACK_MODEL).toBe('openai/whisper-large-v3-turbo');
    expect(timeoutMock.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
      20_000, 25_000, 30_000,
    ]);
    expect(fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body)).model)).toEqual([
      'nvidia/parakeet-tdt-0.6b-v3',
      'nvidia/parakeet-tdt-0.6b-v3',
      'openai/whisper-large-v3-turbo',
    ]);
    expect(result.text).toBe('Fallback riuscito.');
  });
});
