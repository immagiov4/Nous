import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const imageClientMocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
}));

vi.mock('../../src/services/imageClient.js', () => ({
  imageClient: {
    generateImage: imageClientMocks.generateImage,
  },
}));

const { createApp } = await import('../../src/index.js');

describe('POST /api/images/generate', () => {
  beforeEach(() => {
    imageClientMocks.generateImage.mockReset();
    imageClientMocks.generateImage.mockResolvedValue({
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      generationId: 'image-gen-123',
      mediaType: 'image/png',
      usage: { cost: 0.02 },
    });
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
      prompt: 'Sezione di una foglia al microscopio',
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
