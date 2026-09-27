import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/config/chatConfig.js', () => ({
  requireOpenRouterApiKey: () => 'test-key',
}));

const { DEFAULT_TTS_MODEL, ttsClient } = await import('../../src/services/ttsClient.js');
const { default: ttsRouter } = await import('../../src/routes/tts.js');
const { patchGlobalModelConfig, resetModelConfigForTesting } = await import(
  '../../src/config/modelConfig.js'
);

const createAudioResponse = (): Response =>
  new Response(new Uint8Array([1, 2, 3]).buffer, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'x-generation-id': 'gen-openai',
    },
  });

describe('ttsClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetModelConfigForTesting();
  });
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  test('uses the model selected by the global admin configuration', async () => {
    fetchMock.mockResolvedValueOnce(createAudioResponse());

    const audio = await ttsClient.generateSpeech({
      text: 'Ciao.',
      model: 'openai/admin-selected-tts',
      voice: 'Zephyr',
      speed: 1,
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      voice: string;
    };
    expect(requestBody).toMatchObject({
      model: 'openai/admin-selected-tts',
      voice: 'Zephyr',
      response_format: 'mp3',
    });
    expect(audio.contentType).toBe('audio/mpeg');
    expect([...new Uint8Array(audio.audioBuffer)]).toEqual([1, 2, 3]);
    expect(audio.generationId).toBe('gen-openai');
  });

  test.each([
    'audio/pcm;rate=24000;channels=1',
    'audio/pcm; channels=1; rate=24000',
    'Audio/PCM; RATE="24000"; CHANNELS="1"; extra="ignored;value"',
  ])('wraps Gemini PCM in playable WAV for %s', async contentType => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([0, 0, 1, 0]).buffer, {
        headers: { 'content-type': contentType, 'x-generation-id': 'gen-gemini' },
      })
    );

    const audio = await ttsClient.generateSpeech({
      text: 'Ciao.',
      model: DEFAULT_TTS_MODEL,
      voice: 'Kore',
      speed: 1,
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      voice: string;
      response_format: string;
    };
    expect(requestBody.voice).toBe('Kore');
    expect(requestBody.response_format).toBe('pcm');
    expect(audio.contentType).toBe('audio/wav');
    const wav = Buffer.from(audio.audioBuffer);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(28)).toBe(48_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([0, 0, 1, 0]);
    expect(audio.generationId).toBe('gen-gemini');
  });

  test.each([
    ['audio/mpeg', [0, 0]],
    ['audio/pcm;rate=24000', [0, 0]],
    ['audio/pcm;rate=zero;channels=1', [0, 0]],
    ['audio/pcm;rate=0;channels=1', [0, 0]],
    ['audio/pcm;rate=24000;channels=0', [0, 0]],
    ['audio/pcm;rate=24000;channels=1', [0]],
    ['audio/pcm;rate=24000;channels=2', [0, 0]],
    ['audio/pcm;rate=24000;channels=1', []],
  ])('rejects invalid PCM %s with %j bytes', async (contentType, bytes) => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(bytes), {
        headers: { 'content-type': contentType },
      })
    );
    await expect(
      ttsClient.generateSpeech({ text: 'Ciao.', model: DEFAULT_TTS_MODEL })
    ).rejects.toThrow('Invalid Gemini TTS PCM response.');
  });

  test.each([
    ['x-ai/grok-voice-tts-1.0', 'Zephyr', 'Ara'],
    ['x-ai/grok-voice-tts-1.0', 'Puck', 'Ara'],
    ['x-ai/grok-voice-tts-1.0', 'coral', 'Ara'],
    ['x-ai/grok-voice-tts-1.0', 'Eve', 'Eve'],
    [DEFAULT_TTS_MODEL, 'coral', 'Zephyr'],
    [DEFAULT_TTS_MODEL, 'Ara', 'Zephyr'],
    [DEFAULT_TTS_MODEL, 'eve', 'Zephyr'],
    [DEFAULT_TTS_MODEL, 'Kore', 'Kore'],
    [DEFAULT_TTS_MODEL, 'Aoede', 'Aoede'],
    ['other/custom-tts', 'custom-voice', 'custom-voice'],
  ])('normalizes rollout voice for %s: %s -> %s', async (model, voice, expectedVoice) => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([0, 0]), {
        headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' },
      })
    );
    await ttsClient.generateSpeech({ text: 'Ciao.', model, voice });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model,
      voice: expectedVoice,
    });
  });

  test.each([
    ['x-ai/grok-voice-tts-1.0', 'Zephyr', 'Ara', 'audio/mpeg'],
    [DEFAULT_TTS_MODEL, undefined, 'Zephyr', 'audio/wav'],
  ])('serves playable audio through the route during rollout to %s', async (model, voice, expectedVoice, contentType) => {
    patchGlobalModelConfig({ ttsModel: model, ttsVoice: 'coral' });
    fetchMock.mockResolvedValueOnce(
      model === DEFAULT_TTS_MODEL
        ? new Response(new Uint8Array([0, 0, 1, 0]), {
            headers: {
              'content-type': 'audio/pcm; channels=1; rate=24000',
              'x-generation-id': 'gen-route',
            },
          })
        : createAudioResponse()
    );
    const app = express().use(express.json()).use('/api/tts', ttsRouter);
    const response = await request(app).post('/api/tts').send({ text: 'Ciao.', voice });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(contentType);
    expect(Number(response.headers['content-length'])).toBe(response.body.length);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model,
      voice: expectedVoice,
    });
    if (model === DEFAULT_TTS_MODEL) {
      expect(response.body.toString('ascii', 0, 4)).toBe('RIFF');
      expect([...response.body.subarray(44)]).toEqual([0, 0, 1, 0]);
      expect(response.headers['x-generation-id']).toBe('gen-route');
    } else {
      expect([...response.body]).toEqual([1, 2, 3]);
    }
  });

  test('keeps Gemini metadata attached to its model ID under an environment override', async () => {
    vi.stubEnv('MODEL_TTS', 'x-ai/grok-voice-tts-1.0');
    try {
      vi.resetModules();
      const overridden = await import('../../src/services/ttsClient.js');
      expect(overridden.DEFAULT_TTS_MODEL).toBe('x-ai/grok-voice-tts-1.0');
      expect(await overridden.ttsClient.listModels()).toEqual([
        expect.objectContaining({
          id: 'google/gemini-3.8-flash-tts',
          name: 'Google: Gemini 3.8 Flash TTS',
        }),
      ]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

import express from 'express';
import request from 'supertest';
