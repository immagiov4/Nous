import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const voiceServiceMocks = vi.hoisted(() => ({
  getVoiceDetails: vi.fn(),
  listVoices: vi.fn(),
}));

vi.mock('../../src/services/voiceService.js', () => ({
  getVoiceDetails: voiceServiceMocks.getVoiceDetails,
  listVoices: voiceServiceMocks.listVoices,
}));

const { createApp } = await import('../../src/index.js');

describe('GET /api/voices', () => {
  beforeEach(() => {
    voiceServiceMocks.getVoiceDetails.mockReset();
    voiceServiceMocks.listVoices.mockReset();
    voiceServiceMocks.listVoices.mockReturnValue({
      count: 1,
      voices: [{ id: 'mario', name: 'Mario', language: 'it-IT' }],
    });
    voiceServiceMocks.getVoiceDetails.mockReturnValue({
      id: 'mario',
      name: 'Mario',
      language: 'it-IT',
    });
  });

  test('returns the voice catalog payload', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await request(createApp()).get('/api/voices');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      count: 1,
      voices: [{ id: 'mario', name: 'Mario', language: 'it-IT' }],
    });
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('GET /api/voices'));
    logSpy.mockRestore();
  });

  test('returns a voice profile by id', async () => {
    const response = await request(createApp()).get('/api/voices/mario');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      id: 'mario',
      name: 'Mario',
      language: 'it-IT',
    });
  });

  test('returns 404 when the requested voice is missing', async () => {
    voiceServiceMocks.getVoiceDetails.mockReturnValueOnce(null);

    const response = await request(createApp()).get('/api/voices/unknown');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: 'Profilo vocale non trovato.',
    });
  });
});
