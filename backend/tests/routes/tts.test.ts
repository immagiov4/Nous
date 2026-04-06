import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const ttsClientMocks = vi.hoisted(() => ({
  generateSpeech: vi.fn(),
}));

vi.mock('../../src/services/ttsClient.js', () => ({
  ttsClient: {
    generateSpeech: ttsClientMocks.generateSpeech,
  },
}));

const { createApp } = await import('../../src/index.js');

describe('POST /api/tts', () => {
  beforeEach(() => {
    ttsClientMocks.generateSpeech.mockReset();
    ttsClientMocks.generateSpeech.mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
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

  test('returns generated wav audio and cache headers', async () => {
    const response = await request(createApp())
      .post('/api/tts')
      .send({ text: 'Ciao Lumina', voice: 'mario', speed: 1 });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('audio/wav');
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.body).toBeInstanceOf(Buffer);
    expect(ttsClientMocks.generateSpeech).toHaveBeenCalledWith({
      text: 'Ciao Lumina',
      voice: 'mario',
      speed: 1,
    });
  });

  test('returns 503 when the tts server is unavailable', async () => {
    ttsClientMocks.generateSpeech.mockRejectedValueOnce(
      Object.assign(new Error('Connection failed'), { code: 'ECONNREFUSED' })
    );

    const response = await request(createApp()).post('/api/tts').send({ text: 'offline' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: 'TTS server is not available. Please ensure the TTS server is running.',
    });
  });
});
