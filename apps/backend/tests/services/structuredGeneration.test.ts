import { beforeEach, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { generateStructuredOutput } from '../../src/services/structuredGeneration.js';

const { createConfiguredTextModelFromResolution, generateText, runCodexAppServerTurn } = vi.hoisted(
  () => ({
    createConfiguredTextModelFromResolution: vi.fn(),
    generateText: vi.fn(),
    runCodexAppServerTurn: vi.fn(),
  })
);

vi.mock('../../src/services/codexAppServer.js', () => ({ runCodexAppServerTurn }));
vi.mock('../../src/services/aiSdkTextModel.js', () => ({
  createConfiguredTextModelFromResolution,
}));
vi.mock('ai', async importOriginal => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText,
}));

const OUTPUT = {
  name: 'answer',
  schema: {
    additionalProperties: false,
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    type: 'object',
  },
};

const signal = new AbortController().signal;

const request = (provider: 'codex' | 'openrouter') => ({
  config: { ...getGlobalModelConfig(), aiProviderOverrides: { lesson: provider } },
  output: OUTPUT,
  prompt: 'Domanda',
  reasoningEffort: 'medium' as const,
  signal,
  slot: 'lesson' as const,
  system: 'Rispondi.',
});

beforeEach(() => {
  createConfiguredTextModelFromResolution.mockReset();
  generateText.mockReset();
  runCodexAppServerTurn.mockReset();
});

test('Codex turns are tool-free, schema-bound, and parsed as JSON', async () => {
  runCodexAppServerTurn.mockResolvedValue('{"answer":"42"}');

  await expect(generateStructuredOutput(request('codex'))).resolves.toEqual({ answer: '42' });

  expect(generateText).not.toHaveBeenCalled();
  expect(runCodexAppServerTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      allowWebSearch: false,
      developerInstructions: 'Rispondi. Do not use tools or access local files.',
      input: [{ text: 'Domanda', type: 'text' }],
      outputSchema: OUTPUT.schema,
      reasoningEffort: 'medium',
      signal,
    })
  );
});

test('web search lets Codex search while still forbidding local files', async () => {
  runCodexAppServerTurn.mockResolvedValue('{"answer":"42"}');

  await generateStructuredOutput({ ...request('codex'), webSearch: true });

  expect(runCodexAppServerTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      allowWebSearch: true,
      developerInstructions: 'Rispondi. Do not access local files.',
    })
  );
});

test('web search passes the provider search tools to AI SDK models', async () => {
  const tools = { web_search: {} };
  createConfiguredTextModelFromResolution.mockReturnValue({
    model: 'model',
    providerOptions: {},
    tools,
  });
  generateText.mockResolvedValue({ output: { answer: '42' } });

  await generateStructuredOutput({ ...request('openrouter'), webSearch: true });

  expect(createConfiguredTextModelFromResolution).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'openrouter', reasoningEffort: 'medium' }),
    { webSearch: true }
  );
  expect(generateText.mock.lastCall?.[0].tools).toBe(tools);
});

test('malformed Codex output surfaces as a SyntaxError', async () => {
  runCodexAppServerTurn.mockResolvedValue('not json');

  await expect(generateStructuredOutput(request('codex'))).rejects.toBeInstanceOf(SyntaxError);
});

test('AI SDK providers receive the system prompt unchanged', async () => {
  createConfiguredTextModelFromResolution.mockReturnValue({
    model: 'model',
    providerOptions: { p: {} },
  });
  generateText.mockResolvedValue({ output: { answer: '42' } });

  await expect(generateStructuredOutput(request('openrouter'))).resolves.toEqual({
    answer: '42',
  });

  expect(runCodexAppServerTurn).not.toHaveBeenCalled();
  expect(createConfiguredTextModelFromResolution).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'openrouter', reasoningEffort: 'medium' }),
    { webSearch: false }
  );
  const call = generateText.mock.lastCall?.[0];
  expect(call).toMatchObject({
    abortSignal: signal,
    maxRetries: 0,
    prompt: 'Domanda',
    providerOptions: { p: {} },
    system: 'Rispondi.',
  });
  await expect(call.output.responseFormat).resolves.toMatchObject({
    name: 'answer',
    schema: OUTPUT.schema,
    type: 'json',
  });
});

test('a resolved model bypasses slot configuration and keeps its service tier', async () => {
  runCodexAppServerTurn.mockResolvedValue('{"answer":"42"}');

  await generateStructuredOutput({
    model: {
      model: 'pinned-model',
      provider: 'codex',
      reasoningEffort: 'low',
      serviceTier: 'fast',
    },
    output: OUTPUT,
    prompt: 'Domanda',
    signal,
    system: 'Rispondi.',
  });

  expect(runCodexAppServerTurn).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'pinned-model', reasoningEffort: 'low', serviceTier: 'fast' })
  );
});

test('an image precedes the prompt for both providers', async () => {
  runCodexAppServerTurn.mockResolvedValue('{"answer":"42"}');
  await generateStructuredOutput({ ...request('codex'), image: 'data:image/png;base64,AA' });
  expect(runCodexAppServerTurn.mock.lastCall?.[0].input).toEqual([
    { type: 'image', url: 'data:image/png;base64,AA' },
    { text: 'Domanda', type: 'text' },
  ]);

  createConfiguredTextModelFromResolution.mockReturnValue({ model: 'model', providerOptions: {} });
  generateText.mockResolvedValue({ output: { answer: '42' } });
  await generateStructuredOutput({ ...request('openrouter'), image: 'data:image/png;base64,AA' });
  const call = generateText.mock.lastCall?.[0];
  expect(call.prompt).toBeUndefined();
  expect(call.messages).toEqual([
    {
      content: [
        { image: 'data:image/png;base64,AA', type: 'image' },
        { text: 'Domanda', type: 'text' },
      ],
      role: 'user',
    },
  ]);
});

test('AI SDK transport retries are off unless the caller asks for them', async () => {
  createConfiguredTextModelFromResolution.mockReturnValue({ model: 'model', providerOptions: {} });
  generateText.mockResolvedValue({ output: { answer: '42' } });

  await generateStructuredOutput(request('openrouter'));
  expect(generateText.mock.lastCall?.[0].maxRetries).toBe(0);

  await generateStructuredOutput({ ...request('openrouter'), maxRetries: 2 });
  expect(generateText.mock.lastCall?.[0].maxRetries).toBe(2);
});
