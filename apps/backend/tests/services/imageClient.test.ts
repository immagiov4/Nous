import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_IMAGE_MODEL, imageClient } from '../../src/services/imageClient.js';

const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

describe('OpenRouter image client', () => {
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

  test('uses the dedicated image endpoint with a server-owned model', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                b64_json: 'ZmFrZS1pbWFnZQ==',
                media_type: 'image/png',
              },
            ],
            usage: { cost: 0.02 },
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

    const result = await imageClient.generateImage({
      prompt: 'A clear educational cutaway of a plant cell.',
    });

    expect(DEFAULT_IMAGE_MODEL).toBe('google/gemini-3.1-flash-lite-image');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/images',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-openrouter-key',
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      aspect_ratio: '16:9',
      model: 'google/gemini-3.1-flash-lite-image',
      n: 1,
      prompt: 'A clear educational cutaway of a plant cell.',
      resolution: '1K',
    });
    expect(result).toEqual({
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      generationId: 'generation-1',
      mediaType: 'image/png',
      usage: { cost: 0.02 },
    });
  });

  test('rejects successful responses without a valid raster image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ b64_json: 'not base64', media_type: 'image/svg+xml' }],
            }),
            { status: 200 }
          )
      )
    );

    await expect(imageClient.generateImage({ prompt: 'A diagram' })).rejects.toThrow(
      'Il servizio immagini non ha restituito un risultato valido.'
    );
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

    await expect(imageClient.generateImage({ prompt: 'A scene' })).rejects.toThrow(
      'Il servizio immagini non ha completato la richiesta. Riprova tra poco.'
    );
  });
});
