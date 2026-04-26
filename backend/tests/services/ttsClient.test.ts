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

  test('always uses the OpenAI TTS model through OpenRouter', async () => {
    fetchMock.mockResolvedValueOnce(createAudioResponse());

    await ttsClient.generateSpeech({
      text: 'Ciao.',
      model: 'openai/gpt-4o-mini-tts-2025-12-15',
      voice: 'coral',
      speed: 1,
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      voice: string;
    };
    expect(requestBody).toMatchObject({
      model: DEFAULT_TTS_MODEL,
      voice: 'coral',
    });
  });

  test('normalizes unsupported voices to the OpenAI default voice', async () => {
    fetchMock.mockResolvedValueOnce(createAudioResponse());

    await ttsClient.generateSpeech({
      text: 'Ciao.',
      model: DEFAULT_TTS_MODEL,
      voice: 'coral',
      speed: 1,
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      voice: string;
    };
    expect(requestBody.voice).toBe('coral');
  });
});
