import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const imageClientMocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock('../../src/services/imageClient.js', () => ({
  imageClient: {
    generateImage: imageClientMocks.generateImage,
    listModels: imageClientMocks.listModels,
  },
  DEFAULT_IMAGE_MODEL: 'google/gemini-3.1-flash-lite-image',
}));

const { createApp } = await import('../../src/index.js');
const { patchGlobalModelConfig } = await import('../../src/config/modelConfig.js');

describe('POST /api/images/generate', () => {
  beforeEach(() => {
    patchGlobalModelConfig({ aiProvider: 'openrouter' });
    imageClientMocks.generateImage.mockReset();
    imageClientMocks.listModels.mockReset();
    imageClientMocks.listModels.mockResolvedValue([
      { id: 'google/gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite' },
    ]);
    imageClientMocks.generateImage.mockResolvedValue({
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      generationId: 'image-gen-123',
      mediaType: 'image/png',
      usage: { cost: 0.02 },
    });
  });

  test('lists image-capable models together with the effective backend selection', async () => {
    const response = await request(createApp()).get('/api/images/models');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      available: true,
      defaultModel: 'google/gemini-3.1-flash-lite-image',
      selectedModel: expect.any(String),
      models: [{ id: 'google/gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite' }],
    });
  });

  test('reports image generation as unavailable for Codex without using OpenRouter', async () => {
    const modelsResponse = await request(createApp())
      .get('/api/images/models')
      .set('X-Nous-AI-Provider', 'codex');
    const generationResponse = await request(createApp())
      .post('/api/images/generate')
      .set('X-Nous-AI-Provider', 'codex')
      .send({ prompt: 'Schema didattico della fotosintesi' });

    expect(modelsResponse.status).toBe(200);
    expect(modelsResponse.body).toEqual({
      success: true,
      available: false,
      code: 'IMAGE_GENERATION_UNAVAILABLE',
      provider: 'codex',
      models: [],
    });
    expect(generationResponse.status).toBe(503);
    expect(generationResponse.body).toEqual({
      success: false,
      code: 'IMAGE_GENERATION_UNAVAILABLE',
      error: 'Generazione immagini non disponibile con il provider Codex.',
    });
    expect(imageClientMocks.listModels).not.toHaveBeenCalled();
    expect(imageClientMocks.generateImage).not.toHaveBeenCalled();
  });

  test('requires a non-empty prompt', async () => {
    const missingPrompt = await request(createApp()).post('/api/images/generate').send({});
    const blankPrompt = await request(createApp())
      .post('/api/images/generate')
      .send({ prompt: '   ' });

    expect(missingPrompt.status).toBe(400);
    expect(missingPrompt.body).toEqual({
      success: false,
      error: 'Descrizione immagine non valida.',
    });
    expect(blankPrompt.status).toBe(400);
    expect(imageClientMocks.generateImage).not.toHaveBeenCalled();
  });

  test('generates one server-configured image and ignores client model overrides', async () => {
    const response = await request(createApp()).post('/api/images/generate').send({
      prompt: '  Sezione di una foglia al microscopio  ',
      model: 'client/model-must-be-ignored',
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-generation-id']).toBe('image-gen-123');
    expect(response.body).toEqual({
      success: true,
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      mediaType: 'image/png',
      usage: { cost: 0.02 },
    });
    expect(imageClientMocks.generateImage).toHaveBeenCalledWith({
      model: expect.any(String),
      prompt: 'Sezione di una foglia al microscopio',
      provider: 'openrouter',
    });
  });

  test('uses an OpenAI image model for a request-scoped OpenAI preference', async () => {
    const response = await request(createApp())
      .post('/api/images/generate')
      .set('X-Nous-AI-Provider', 'openai')
      .send({ prompt: 'Diagramma didattico della fotosintesi' });

    expect(response.status).toBe(200);
    expect(imageClientMocks.generateImage).toHaveBeenCalledWith({
      model: expect.stringMatching(/^gpt-image-/),
      prompt: 'Diagramma didattico della fotosintesi',
      provider: 'openai',
    });
  });

  test('returns a safe gateway error when generation fails', async () => {
    imageClientMocks.generateImage.mockRejectedValueOnce(new Error('provider secret detail'));

    const response = await request(createApp()).post('/api/images/generate').send({
      prompt: 'Una ricostruzione storica',
    });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      success: false,
      error: 'Generazione immagine non riuscita.',
    });
  });
});
