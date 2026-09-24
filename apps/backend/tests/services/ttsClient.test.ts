import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/config/chatConfig.js', () => ({
  requireOpenRouterApiKey: () => 'test-key',
}));

const { DEFAULT_TTS_MODEL, ttsClient } = await import('../../src/services/ttsClient.js');

const createAudioResponse = (): Response =>
  new Response(new Uint8Array([1, 2, 3]).buffer, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'x-generation-id': 'gen-openai',
    },
  });

describe('ttsClient', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  test('uses the model selected by the global admin configuration', async () => {
    fetchMock.mockResolvedValueOnce(createAudioResponse());

    await ttsClient.generateSpeech({
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
    });
  });

  test('passes the selected voice to the configured TTS model', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([0, 0, 1, 0]).buffer, {
        headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' },
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
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([0, 0, 1, 0]);
  });
});
