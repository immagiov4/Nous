import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const modelConfigMocks = vi.hoisted(() => ({
  getResolvedGlobalModelConfig: vi.fn(),
}));

vi.mock('../../src/config/modelConfig.js', () => ({
  DEFAULT_IMAGE_MODEL: 'google/gemini-3.1-flash-lite-image',
  DEFAULT_OPENAI_IMAGE_MODEL: 'gpt-image-2',
  getResolvedGlobalModelConfig: modelConfigMocks.getResolvedGlobalModelConfig,
}));

const { imageClient } = await import('../../src/services/imageClient.js');

const ORIGINAL_ENV = { ...process.env };

describe('ImageClient', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    modelConfigMocks.getResolvedGlobalModelConfig.mockReset();
    modelConfigMocks.getResolvedGlobalModelConfig.mockResolvedValue({
      aiProvider: 'openrouter',
      imageModel: 'google/configured-image-model',
      openAiImageModel: 'gpt-image-2',
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  test('uses the image model selected by the backend configuration', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: 'ZmFrZS1pbWFnZQ==', media_type: 'image/png' }],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await imageClient.generateImage({ prompt: 'Schema didattico' });

    expect(result).toMatchObject({
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      mediaType: 'image/png',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/images',
      expect.objectContaining({
        body: expect.any(String),
        method: 'POST',
      })
    );
    const requestBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    ) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      model: 'google/configured-image-model',
      prompt: 'Schema didattico',
    });
  });

  test('accepts only models returned by the image-specific catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: 'google/image-capable', name: 'Image capable' },
                { id: '', name: 'Invalid' },
              ],
            }),
            { status: 200 }
          )
      )
    );

    await expect(
      imageClient.assertModelSupportsImage('google/image-capable')
    ).resolves.toBeUndefined();
    await expect(imageClient.assertModelSupportsImage('google/text-only')).rejects.toThrow(
      'Il modello selezionato non supporta la generazione immagini.'
    );
  });

  test('uses the configured OpenAI image model through the Images API contract', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    modelConfigMocks.getResolvedGlobalModelConfig.mockResolvedValue({
      aiProvider: 'openai',
      imageModel: 'google/configured-image-model',
      openAiImageModel: 'gpt-image-2',
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: 'ZmFrZS1pbWFnZQ==' }] }), {
          status: 200,
          headers: { 'x-request-id': 'openai-request-1' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await imageClient.generateImage({ prompt: 'Schema didattico' });

    expect(result).toMatchObject({
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      generationId: 'openai-request-1',
      mediaType: 'image/png',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/images/generations');
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-openai-key');
    expect(JSON.parse(String(options.body))).toEqual({
      model: 'gpt-image-2',
      n: 1,
      output_format: 'png',
      prompt: 'Schema didattico',
      quality: 'medium',
      size: '1536x1024',
    });
  });
});
