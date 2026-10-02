import { beforeEach, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { generateStructuredOutput } from '../../src/services/structuredGeneration.js';

const { createConfiguredTextModel, generateText, runCodexAppServerTurn } = vi.hoisted(() => ({
  createConfiguredTextModel: vi.fn(),
  generateText: vi.fn(),
  runCodexAppServerTurn: vi.fn(),
}));

vi.mock('../../src/services/codexAppServer.js', () => ({ runCodexAppServerTurn }));
vi.mock('../../src/services/aiSdkTextModel.js', () => ({ createConfiguredTextModel }));
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

const request = (provider: 'codex' | 'openrouter') => ({
  config: { ...getGlobalModelConfig(), aiProviderOverrides: { lesson: provider } },
  output: OUTPUT,
  prompt: 'Domanda',
  reasoningEffort: 'medium' as const,
  signal: new AbortController().signal,
  slot: 'lesson' as const,
  system: 'Rispondi.',
});

beforeEach(() => {
  createConfiguredTextModel.mockReset();
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
  createConfiguredTextModel.mockReturnValue({ model: 'model', providerOptions: {}, tools });
  generateText.mockResolvedValue({ output: { answer: '42' } });

  await generateStructuredOutput({ ...request('openrouter'), webSearch: true });

  expect(createConfiguredTextModel).toHaveBeenCalledWith(expect.anything(), 'lesson', {
    reasoningEffort: 'medium',
    webSearch: true,
  });
  expect(generateText.mock.lastCall?.[0].tools).toBe(tools);
});

test('malformed Codex output surfaces as a SyntaxError', async () => {
  runCodexAppServerTurn.mockResolvedValue('not json');

  await expect(generateStructuredOutput(request('codex'))).rejects.toBeInstanceOf(SyntaxError);
});

test('AI SDK providers receive the system prompt unchanged', async () => {
  createConfiguredTextModel.mockReturnValue({ model: 'model', providerOptions: { p: {} } });
  generateText.mockResolvedValue({ output: { answer: '42' } });

  await expect(generateStructuredOutput(request('openrouter'))).resolves.toEqual({
    answer: '42',
  });

  expect(runCodexAppServerTurn).not.toHaveBeenCalled();
  expect(createConfiguredTextModel).toHaveBeenCalledWith(expect.anything(), 'lesson', {
    reasoningEffort: 'medium',
    webSearch: false,
  });
  expect(generateText.mock.lastCall?.[0]).toMatchObject({
    maxRetries: 0,
    prompt: 'Domanda',
    providerOptions: { p: {} },
    system: 'Rispondi.',
  });
});
