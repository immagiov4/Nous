import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  CodexJsonRpcClient,
  type CodexTurnInput,
  runCodexAppServerTurnWithClient,
} from '../../src/services/codexAppServer.js';
import { captionPdfImage } from '../../src/services/pdfImageCaption.js';
import { generateStructuredOutput } from '../../src/services/structuredGeneration.js';
import { generateCourseObject } from '../../src/workflows/courseGenerationModel.js';
import { type ModelExchange, withModelExchanges } from '../../src/workflows/modelExchanges.js';
import { runWithWorkflowAttemptMetering } from '../../src/workflows/workflowAiMetering.js';

const { chat, runCodexAppServerTurn } = vi.hoisted(() => ({
  chat: vi.fn(),
  runCodexAppServerTurn: vi.fn(),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => ({ chat }) }));
vi.mock('../../src/services/codexAppServer.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/services/codexAppServer.js')>()),
  runCodexAppServerTurn,
}));

const workflow = { runId: 'run-course', nodeInstanceId: 'node-plan', attemptNumber: 2 };
let responseText: string;

// Replace the transport only: production adapters and capture hooks handle the request.
const runFakeCodexTurn = async (turn: CodexTurnInput): Promise<string> => {
  const transport = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  const send = (message: unknown) => transport.stdout.write(`${JSON.stringify(message)}\n`);
  transport.stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk)) as { id: number; method: string };
    if (request.method === 'account/read') {
      send({ id: request.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
    } else if (request.method === 'thread/start') {
      send({ id: request.id, result: { thread: { id: 'thread-test' } } });
    } else if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'turn-test' } } });
      queueMicrotask(() => {
        send({
          method: 'item/completed',
          params: {
            threadId: 'thread-test',
            item: { id: 'message-test', type: 'agentMessage', text: responseText },
          },
        });
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } },
        });
      });
    }
  });
  const client = new CodexJsonRpcClient(transport);
  try {
    return await runCodexAppServerTurnWithClient(turn, client);
  } finally {
    client.close();
  }
};

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key');
  responseText = '{"title":"Corso"}';
  runCodexAppServerTurn.mockImplementation(runFakeCodexTurn);
  chat.mockReturnValue({
    specificationVersion: 'v3',
    provider: 'openrouter',
    modelId: 'synthetic-model',
    supportedUrls: { 'image/*': [/^data:/] },
    doGenerate: async () => ({
      content: [{ type: 'text', text: responseText }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 3 },
        outputTokens: { total: 2 },
      },
      warnings: [],
    }),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const capture = async (operation: () => Promise<unknown>): Promise<ModelExchange[]> => {
  const records: ModelExchange[] = [];
  await withModelExchanges(records, () =>
    runWithWorkflowAttemptMetering({ ...workflow, record: async () => undefined }, operation)
  );
  // Observe the same JSON representation written by the real-run evidence harness.
  return JSON.parse(JSON.stringify(records)) as ModelExchange[];
};

for (const provider of ['codex', 'openrouter'] as const) {
  test.each([
    'course',
    'research',
    'assessment',
  ] as const)(`${provider} course objects retain role, slot, schema and durable attempt for %s`, async slot => {
    const name = `${slot}_plan`;
    const records = await capture(async () => {
      const output = await generateCourseObject({
        config: { ...getGlobalModelConfig(), aiProvider: provider, aiProviderOverrides: {} },
        developerInstructions: 'Return a title.',
        name,
        prompt: 'Plan the course.',
        schema: z.object({ title: z.string() }).strict(),
        signal: new AbortController().signal,
        slot,
      });
      expect(output).toEqual({ title: 'Corso' });
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider,
      role: name,
      slot,
      workflow,
      request: { outputSchemaName: name },
      response: responseText,
    });
  });

  test(`${provider} PDF captions retain operation and research slot`, async () => {
    responseText = 'Diagramma di un albero.';
    const records = await capture(async () => {
      expect(
        await captionPdfImage(
          { dataUrl: 'data:image/png;base64,aGVsbG8=' },
          { ...getGlobalModelConfig(), aiProvider: provider, aiProviderOverrides: {} },
          new AbortController().signal
        )
      ).toBe(responseText);
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider,
      role: 'pdfImageCaption',
      slot: 'research',
      workflow,
    });
  });

  test.each([
    false,
    true,
  ])(`${provider} structured target retains identity (resolved=%s)`, async resolved => {
    const config = { ...getGlobalModelConfig(), aiProvider: provider, aiProviderOverrides: {} };
    const records = await capture(async () => {
      expect(
        await generateStructuredOutput({
          ...(resolved
            ? { model: { provider, model: 'synthetic-model', reasoningEffort: 'low' as const } }
            : { config, slot: 'lesson' as const }),
          output: {
            name: 'lesson_plan',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { title: { type: 'string' } },
              required: ['title'],
            },
          },
          prompt: 'Plan a lesson.',
          system: 'Return a title.',
          signal: new AbortController().signal,
        })
      ).toEqual({ title: 'Corso' });
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider,
      role: 'lesson_plan',
      workflow,
      request: { outputSchemaName: 'lesson_plan' },
    });
    expect(records[0].slot).toBe(resolved ? undefined : 'lesson');
  });
}
