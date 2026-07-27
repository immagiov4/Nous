import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sttClientMocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
}));

vi.mock('../../src/services/sttClient.js', () => ({
  DEFAULT_STT_MODEL: 'nvidia/parakeet-tdt-0.6b-v3',
  SUPPORTED_STT_AUDIO_FORMATS: ['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav', 'webm'],
  sttClient: {
    transcribeAudio: sttClientMocks.transcribeAudio,
  },
}));

const { createApp } = await import('../../src/index.js');

const VALID_AUDIO_DATA = Buffer.from('fake webm audio').toString('base64');

describe('POST /api/stt', () => {
  beforeEach(() => {
    sttClientMocks.transcribeAudio.mockReset();
    sttClientMocks.transcribeAudio.mockResolvedValue({
      text: 'Questa è una trascrizione.',
      usage: {
        cost: 0.000025,
        seconds: 1,
      },
      generationId: 'stt-gen-123',
    });
  });

  test('requires base64 audio data and a supported format', async () => {
    const missingAudio = await request(createApp()).post('/api/stt').send({});
    const unsupportedFormat = await request(createApp()).post('/api/stt').send({
      data: VALID_AUDIO_DATA,
      format: 'avi',
    });

    expect(missingAudio.status).toBe(400);
    expect(missingAudio.body).toEqual({
      success: false,
      error: 'Audio non valido.',
    });
    expect(unsupportedFormat.status).toBe(400);
    expect(unsupportedFormat.body).toEqual({
      success: false,
      error: 'Formato audio non supportato.',
    });
  });

  test('rejects malformed base64 and invalid language codes', async () => {
    const malformedAudio = await request(createApp()).post('/api/stt').send({
      data: 'not-base64!',
      format: 'webm',
    });
    const invalidLanguage = await request(createApp()).post('/api/stt').send({
      data: VALID_AUDIO_DATA,
      format: 'webm',
      language: 'italiano',
    });

    expect(malformedAudio.status).toBe(400);
    expect(malformedAudio.body.error).toBe('Audio non valido.');
    expect(invalidLanguage.status).toBe(400);
    expect(invalidLanguage.body.error).toBe('Codice lingua non valido.');
  });

  test('returns the Parakeet transcription and tracking header', async () => {
    const response = await request(createApp()).post('/api/stt').send({
      data: VALID_AUDIO_DATA,
      format: 'webm',
      language: 'it',
      model: 'client/model-must-be-ignored',
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-generation-id']).toBe('stt-gen-123');
    expect(response.body).toEqual({
      success: true,
      text: 'Questa è una trascrizione.',
      usage: {
        cost: 0.000025,
        seconds: 1,
      },
    });
    expect(sttClientMocks.transcribeAudio).toHaveBeenCalledWith({
      data: VALID_AUDIO_DATA,
      format: 'webm',
      language: 'it',
    });
  });

  test('returns a safe gateway error when transcription fails', async () => {
    sttClientMocks.transcribeAudio.mockRejectedValueOnce(new Error('provider secret detail'));

    const response = await request(createApp()).post('/api/stt').send({
      data: VALID_AUDIO_DATA,
      format: 'webm',
    });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      success: false,
      error: 'Trascrizione non riuscita.',
    });
  });
});
