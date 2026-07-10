import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createApp } from '../../src/index.js';

const ORIGINAL_ENV = { ...process.env };

describe('protected backend API routes', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AUTH_MODE: 'supabase',
      SUPABASE_JWT_SECRET: 'test-secret',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('rejects unauthenticated access to project, AI, PDF, TTS, STT, and image APIs', async () => {
    const app = createApp();
    const protectedRequests = [
      request(app).get('/api/projects/projects'),
      request(app).post('/api/chat/context').send({}),
      request(app).post('/api/openrouter/chat/completions').send({ messages: [] }),
      request(app).post('/api/pdf/extract-text').send({ fileData: '' }),
      request(app).post('/api/tts').send({ text: 'ciao' }),
      request(app).post('/api/stt').send({ data: 'YXVkaW8=', format: 'webm' }),
      request(app).post('/api/images/generate').send({ prompt: 'Una cellula vegetale' }),
    ];

    const responses = await Promise.all(protectedRequests);

    expect(responses.map(response => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
    for (const response of responses) {
      expect(response.body).toEqual({
        success: false,
        error: 'Accesso richiesto.',
      });
    }
  });

  test('keeps health/status public for deployment probes', async () => {
    const app = createApp();

    const healthResponse = await request(app).get('/health');
    const statusResponse = await request(app).get('/api/status');

    expect(healthResponse.status).toBe(200);
    expect(statusResponse.status).toBe(200);
  });
});
