import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'https://backend.test',
  MAX_OUTPUT_TOKENS: 32000,
  resolveOpenRouterModel: (model: string) => model,
}));

const { callOpenRouter, callOpenRouterRaw } = await import(
  '../../../services/openrouter/client.ts'
);

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

test('marks optional artifact previews for a text-only fallback', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
  });

  await callOpenRouterRaw({
    allowTextOnlyImageFallback: true,
    model: 'renderer-model',
    modelSlot: 'artifact',
    messages: [{ role: 'user', content: 'Euristica SVG' }],
  });

  const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  assert.equal(headers.get('X-Nous-Allow-Text-Only-Image-Fallback'), 'true');
  assert.equal(headers.get('X-Nous-Model-Slot'), 'artifact');
});

test('callOpenRouterRaw surfaces proxy payload limit failures with a clear message', async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 413,
    statusText: 'Payload Too Large',
    text: async () => '{"success":false,"error":"Il file e troppo grande per questa richiesta."}',
  });

  await assert.rejects(
    () =>
      callOpenRouterRaw({
        model: 'openai/gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Test prompt' }],
      }),
    (error: unknown) =>
      error instanceof Error && /richiesta al modello e troppo grande/i.test(error.message)
  );
});

test('callOpenRouter streams reasoning chunks without paragraph-splitting duplicate fragments', async () => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          [
            'data: {"choices":[{"delta":{"reasoning":"I","reasoning_details":[{"type":"reasoning.text","text":"I"}]}}]}',
            '',
            `data: {"choices":[{"delta":{"reasoning":"'m considering","reasoning_details":[{"type":"reasoning.text","text":"'m considering"}]}}]}`,
            '',
            'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n')
        )
      );
      controller.close();
    },
  });
  const reasoningUpdates: string[] = [];

  fetchMock.mockResolvedValue({
    body: stream,
    ok: true,
  });

  const response = await callOpenRouter({
    model: 'openai/gpt-5.4-mini',
    messages: [{ role: 'user', content: 'Test prompt' }],
    onReasoningUpdate: reasoning => reasoningUpdates.push(reasoning),
    reasoning: {
      effort: 'high',
      exclude: false,
    },
  });

  const request = fetchMock.mock.calls[0]?.[1];
  const body = JSON.parse(String(request?.body || '{}')) as {
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
  };
  assert.equal(body.stream, true);
  assert.equal(body.stream_options?.include_usage, true);
  assert.equal(response, '{"ok":true}');
  assert.deepEqual(reasoningUpdates, ['I', "I'm considering"]);
});

test('callOpenRouter preserves paragraph breaks between distinct reasoning sections', async () => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          [
            'data: {"choices":[{"delta":{"reasoning":"Designing a quiz.","reasoning_details":[{"type":"reasoning.text","text":"I\'m planning a quiz."}]}}]}',
            '',
            'data: {"choices":[{"delta":{"reasoning":"Analyzing cost elements."}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n')
        )
      );
      controller.close();
    },
  });
  const reasoningUpdates: string[] = [];

  fetchMock.mockResolvedValue({
    body: stream,
    ok: true,
  });

  await callOpenRouter({
    model: 'openai/gpt-5.4-mini',
    messages: [{ role: 'user', content: 'Test prompt' }],
    onReasoningUpdate: reasoning => reasoningUpdates.push(reasoning),
    reasoning: {
      effort: 'high',
      exclude: false,
    },
  });

  assert.deepEqual(reasoningUpdates, [
    "Designing a quiz.\n\nI'm planning a quiz.",
    "Designing a quiz.\n\nI'm planning a quiz.\n\nAnalyzing cost elements.",
  ]);
});

test('callOpenRouter uses streamed content when a provider exposes no reasoning', async () => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          [
            'data: {"choices":[{"delta":{"content":"First"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":" section"}}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n')
        )
      );
      controller.close();
    },
  });
  const progressUpdates: string[] = [];
  fetchMock.mockResolvedValue({ body: stream, ok: true });

  await callOpenRouter({
    model: 'provider/without-reasoning',
    messages: [{ role: 'user', content: 'Test prompt' }],
    onReasoningUpdate: update => progressUpdates.push(update),
  });

  assert.deepEqual(progressUpdates, ['First', 'First section']);
});

test('callOpenRouter preserves provider URL citations for the research structurer', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: 'Brief grounded.',
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  content: 'Evidence excerpt',
                  title: 'Official source',
                  url: 'https://example.com/source',
                },
              },
            ],
          },
        },
      ],
      usage: { server_tool_use: { web_search_requests: 2 } },
    }),
  });

  const response = await callOpenRouter({
    includeUrlCitationsInText: true,
    model: 'openai/gpt-5.4-mini',
    messages: [{ role: 'user', content: 'Research' }],
  });

  assert.match(response, /FONTI WEB RESTITUITE DAL PROVIDER/);
  assert.match(response, /Official source: https:\/\/example\.com\/source/);
  assert.match(response, /Evidence excerpt/);
});
