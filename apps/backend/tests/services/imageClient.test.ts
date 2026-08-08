import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runWithWorkflowAttemptMetering } from '../../src/workflows/workflowAiMetering.js';

const modelConfigMocks = vi.hoisted(() => ({
  getResolvedGlobalModelConfig: vi.fn(),
}));
const codexMocks = vi.hoisted(() => ({
  generateCodexAppServerImage: vi.fn(),
}));

vi.mock('../../src/config/modelConfig.js', () => ({
  DEFAULT_IMAGE_MODEL: 'google/gemini-3.1-flash-lite-image',
  DEFAULT_OPENAI_IMAGE_MODEL: 'gpt-image-2',
  getResolvedGlobalModelConfig: modelConfigMocks.getResolvedGlobalModelConfig,
}));

vi.mock('../../src/services/codexAppServer.js', () => codexMocks);

const { imageClient } = await import('../../src/services/imageClient.js');

const ORIGINAL_ENV = { ...process.env };

describe('ImageClient', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    modelConfigMocks.getResolvedGlobalModelConfig.mockReset();
    modelConfigMocks.getResolvedGlobalModelConfig.mockResolvedValue({
      aiProvider: 'openrouter',
      codexArtifactModel: 'gpt-codex-artifact',
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
            usage: { cost: 0.02, input_tokens: 11, output_tokens: 7 },
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const recordAiUsage = vi.fn(async () => undefined);
    const result = await runWithWorkflowAttemptMetering(
      {
        attemptNumber: 1,
        nodeInstanceId: 'root/image',
        record: recordAiUsage,
        runId: '11111111-1111-4111-8111-111111111111',
      },
      () => imageClient.generateImage({ prompt: 'Schema didattico' })
    );

    expect(result).toMatchObject({
      bytes: new TextEncoder().encode('fake-image'),
      mediaType: 'image/png',
    });
    expect(result).not.toHaveProperty('dataUrl');
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
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(
      AbortSignal
    );
    expect(requestBody).toMatchObject({
      model: 'google/configured-image-model',
      prompt: 'Schema didattico',
    });
    expect(recordAiUsage).toHaveBeenCalledWith({
      attemptNumber: 1,
      id: expect.any(String),
      inputTokens: 11,
      model: 'google/configured-image-model',
      nodeInstanceId: 'root/image',
      outputTokens: 7,
      provider: 'openrouter',
      providerCost: 0.02,
      runId: '11111111-1111-4111-8111-111111111111',
    });
  });

  test('does not reload mutable global configuration for an explicitly resolved request', async () => {
    modelConfigMocks.getResolvedGlobalModelConfig.mockRejectedValue(
      new Error('configuration store unavailable')
    );
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

    await expect(
      imageClient.generateImage({
        model: 'google/frozen-image-model',
        prompt: 'Schema didattico',
        provider: 'openrouter',
      })
    ).resolves.toMatchObject({ mediaType: 'image/png' });

    expect(modelConfigMocks.getResolvedGlobalModelConfig).not.toHaveBeenCalled();
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: 'google/frozen-image-model',
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
      bytes: new TextEncoder().encode('fake-image'),
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

  test('uses the authenticated Codex image capability without an API fetch', async () => {
    modelConfigMocks.getResolvedGlobalModelConfig.mockResolvedValue({
      aiProvider: 'codex',
      codexArtifactModel: 'gpt-codex-artifact',
      imageModel: 'google/configured-image-model',
      openAiImageModel: 'gpt-image-2',
    });
    codexMocks.generateCodexAppServerImage.mockResolvedValueOnce('ZmFrZS1pbWFnZQ==');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = await imageClient.generateImage({
      prompt: 'Personaggio da più prospettive',
      signal: controller.signal,
    });

    expect(result).toEqual({
      bytes: new TextEncoder().encode('fake-image'),
      mediaType: 'image/png',
    });
    expect(codexMocks.generateCodexAppServerImage).toHaveBeenCalledWith({
      model: 'gpt-codex-artifact',
      prompt: 'Personaggio da più prospettive',
      signal: controller.signal,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
