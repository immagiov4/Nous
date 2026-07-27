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
      voice: 'Ara',
      speed: 1,
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      voice: string;
    };
    expect(requestBody).toMatchObject({
      model: 'openai/admin-selected-tts',
      voice: 'Ara',
    });
  });

  test('passes the selected voice to the configured TTS model', async () => {
    fetchMock.mockResolvedValueOnce(createAudioResponse());

    await ttsClient.generateSpeech({
      text: 'Ciao.',
      model: DEFAULT_TTS_MODEL,
      voice: 'Eve',
      speed: 1,
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      voice: string;
    };
    expect(requestBody.voice).toBe('Eve');
  });
});
