import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const ttsClientMocks = vi.hoisted(() => ({
  generateSpeech: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock('../../src/services/ttsClient.js', () => ({
  DEFAULT_TTS_MODEL: 'openai/gpt-4o-mini-tts-2025-12-15',
  ttsClient: {
    generateSpeech: ttsClientMocks.generateSpeech,
    listModels: ttsClientMocks.listModels,
  },
}));

const { createApp } = await import('../../src/index.js');

describe('POST /api/tts', () => {
  beforeEach(() => {
    ttsClientMocks.generateSpeech.mockReset();
    ttsClientMocks.listModels.mockReset();
    ttsClientMocks.generateSpeech.mockResolvedValue({
      audioBuffer: new Uint8Array([1, 2, 3, 4]).buffer,
      contentType: 'audio/mpeg',
      generationId: 'gen-123',
    });
    ttsClientMocks.listModels.mockResolvedValue([
      {
        contextLength: 4096,
        id: 'openai/gpt-4o-mini-tts-2025-12-15',
        name: 'OpenAI: GPT-4o Mini TTS',
        pricing: { completion: '0', prompt: '0.0000006' },
        supportedParameters: ['response_format'],
        supportsVoiceCloning: false,
      },
    ]);
  });

  test('validates that text is present', async () => {
    const response = await request(createApp()).post('/api/tts').send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'Text is required and must be a string',
    });
  });

  test('rejects overly long text payloads', async () => {
    const response = await request(createApp())
      .post('/api/tts')
      .send({ text: 'a'.repeat(10001) });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'Text too long. Maximum 10000 characters per request.',
    });
  });

  test('returns generated OpenRouter audio and cache headers', async () => {
    const response = await request(createApp()).post('/api/tts').send({
      text: 'Ciao Lumina',
      model: 'openai/gpt-4o-mini-tts-2025-12-15',
      voice: 'coral',
      speed: 1,
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('audio/mpeg');
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.headers['x-generation-id']).toBe('gen-123');
    expect(response.body).toBeInstanceOf(Buffer);
    expect(ttsClientMocks.generateSpeech).toHaveBeenCalledWith({
      text: 'Ciao Lumina',
      model: 'openai/gpt-4o-mini-tts-2025-12-15',
      voice: 'coral',
      speed: 1,
    });
  });

  test('returns a safe gateway error when OpenRouter TTS is unavailable', async () => {
    ttsClientMocks.generateSpeech.mockRejectedValueOnce(new Error('TTS unavailable'));

    const response = await request(createApp()).post('/api/tts').send({ text: 'offline' });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      success: false,
      error: 'Failed to generate speech',
    });
  });

  test('returns the OpenRouter TTS model catalog', async () => {
    const response = await request(createApp()).get('/api/tts/models');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      defaultModel: 'openai/gpt-4o-mini-tts-2025-12-15',
      models: [
        {
          contextLength: 4096,
          id: 'openai/gpt-4o-mini-tts-2025-12-15',
          name: 'OpenAI: GPT-4o Mini TTS',
          pricing: { completion: '0', prompt: '0.0000006' },
          supportedParameters: ['response_format'],
          supportsVoiceCloning: false,
        },
      ],
    });
  });
});
