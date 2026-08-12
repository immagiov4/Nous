import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createSupabaseTestToken } from '../helpers/auth.js';

const imageClientMocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  listModels: vi.fn(),
  listOpenAiModels: vi.fn(),
}));
const ORIGINAL_ENV = { ...process.env };

vi.mock('../../src/services/imageClient.js', () => ({
  imageClient: {
    generateImage: imageClientMocks.generateImage,
    listModels: imageClientMocks.listModels,
    listOpenAiModels: imageClientMocks.listOpenAiModels,
  },
  DEFAULT_IMAGE_MODEL: 'google/gemini-3.1-flash-lite-image',
  toGeneratedImageDataUrl: (image: { bytes: Uint8Array; mediaType: string }) =>
    `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`,
}));

const { createApp } = await import('../../src/index.js');
const { patchGlobalModelConfig } = await import('../../src/config/modelConfig.js');

describe('POST /api/images/generate', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    patchGlobalModelConfig({ aiProvider: 'openrouter' });
    imageClientMocks.generateImage.mockReset();
    imageClientMocks.listModels.mockReset();
    imageClientMocks.listOpenAiModels.mockReset();
    imageClientMocks.listModels.mockResolvedValue([
      { id: 'google/gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite' },
    ]);
    imageClientMocks.listOpenAiModels.mockReturnValue([{ id: 'gpt-image-2', name: 'gpt-image-2' }]);
    imageClientMocks.generateImage.mockResolvedValue({
      bytes: new TextEncoder().encode('fake-image'),
      generationId: 'image-gen-123',
      mediaType: 'image/png',
      usage: { cost: 0.02 },
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
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

  test('routes Codex image generation through the authenticated app-server capability', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    patchGlobalModelConfig({ codexArtifactModel: 'gpt-codex-artifact' });
    const token = createSupabaseTestToken({ aiProvider: 'codex' });
    const modelsResponse = await request(createApp())
      .get('/api/images/models')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-AI-Provider', 'openai');
    const generationResponse = await request(createApp())
      .post('/api/images/generate')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-AI-Provider', 'openai')
      .send({ prompt: 'Schema didattico della fotosintesi' });

    expect(modelsResponse.status).toBe(200);
    expect(modelsResponse.body).toMatchObject({
      success: true,
      available: true,
      defaultModel: 'gpt-codex-artifact',
      selectedModel: 'gpt-codex-artifact',
      models: [{ id: 'gpt-codex-artifact', name: 'gpt-codex-artifact' }],
    });
    expect(generationResponse.status).toBe(200);
    expect(imageClientMocks.generateImage).toHaveBeenCalledWith({
      model: expect.stringMatching(/^gpt-/),
      prompt: 'Schema didattico della fotosintesi',
      provider: 'codex',
    });
    expect(imageClientMocks.listModels).not.toHaveBeenCalled();
    expect(imageClientMocks.listOpenAiModels).not.toHaveBeenCalled();
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

  test('uses the authenticated user OpenAI provider and ignores request headers', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    const token = createSupabaseTestToken({ aiProvider: 'openai' });
    const response = await request(createApp())
      .post('/api/images/generate')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-AI-Provider', 'codex')
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
