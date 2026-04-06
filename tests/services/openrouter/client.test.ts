import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

vi.mock('../../../services/openrouter/config.ts', () => ({
  MAX_OUTPUT_TOKENS: 32000,
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_BASE_URL: 'https://openrouter.test',
  resolveOpenRouterModel: (model: string) => model,
}));

const { callOpenRouterRaw } = await import('../../../services/openrouter/client.ts');

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

test('callOpenRouterRaw forwards reasoning settings to OpenRouter', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
  });

  await callOpenRouterRaw({
    model: 'openai/gpt-5.4-mini',
    messages: [{ role: 'user', content: 'Test prompt' }],
    reasoning: {
      effort: 'high',
      exclude: true,
    },
  });

  const request = fetchMock.mock.calls[0]?.[1];
  const body = JSON.parse(String(request?.body || '{}')) as {
    reasoning?: { effort?: string; exclude?: boolean };
  };

  assert.deepEqual(body.reasoning, {
    effort: 'high',
    exclude: true,
  });
});
