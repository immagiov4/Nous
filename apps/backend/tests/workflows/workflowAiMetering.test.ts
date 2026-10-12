import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { describe, expect, test, vi } from 'vitest';
import {
  type ModelExchange,
  startModelExchange,
  withModelExchanges,
} from '../../src/workflows/modelExchanges.js';

import {
  meterWorkflowLanguageModel,
  recordWorkflowAiUsage,
  runWithWorkflowAttemptMetering,
} from '../../src/workflows/workflowAiMetering.js';

type LanguageModelV3 = Extract<LanguageModel, { readonly specificationVersion: 'v3' }>;
type LanguageModelGenerateResult = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware['wrapGenerate']>>
>;

const generateResult: LanguageModelGenerateResult = {
  content: [{ text: 'ok', type: 'text' }],
  finishReason: { raw: 'stop', unified: 'stop' },
  providerMetadata: {
    openrouter: {
      usage: {
        cost: 0.0042,
      },
    },
  },
  usage: {
    inputTokens: { cacheRead: 3, cacheWrite: 2, noCache: 7, total: 12 },
    outputTokens: { reasoning: 2, text: 3, total: 5 },
  },
  warnings: [],
};

const fakeModel = (result: LanguageModelGenerateResult): LanguageModelV3 => ({
  doGenerate: vi.fn(async () => result),
  doStream: vi.fn(async () => ({ stream: new ReadableStream() })),
  modelId: 'fake-model',
  provider: 'fake-provider',
  specificationVersion: 'v3',
  supportedUrls: {},
});

describe('workflow AI metering', () => {
  test.each([
    'start-error',
    'read-error',
    'cancel',
    'incomplete',
  ] as const)('finalizes SDK stream capture on %s without changing its outcome', async outcome => {
    const records: ModelExchange[] = [];
    const failure = new Error('private-provider-key');
    const model = fakeModel(generateResult);
    const cancel = vi.fn();
    vi.mocked(model.doStream).mockImplementationOnce(async () => {
      if (outcome === 'start-error') throw failure;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (outcome === 'read-error') controller.error(failure);
            if (outcome === 'incomplete') controller.close();
          },
          cancel,
        }),
      };
    });
    await withModelExchanges(records, async () => {
      const run = async () => {
        const result = await meterWorkflowLanguageModel(model, {
          model: 'fixture',
          provider: 'openrouter',
        }).doStream({ prompt: [] });
        if (outcome === 'cancel') await result.stream.cancel('caller cancelled');
        else await result.stream.getReader().read();
      };
      if (outcome === 'start-error' || outcome === 'read-error')
        await expect(run()).rejects.toBe(failure);
      else await run();
    });
    const status = {
      'start-error': 'error',
      'read-error': 'error',
      cancel: 'cancelled',
      incomplete: 'incomplete',
    }[outcome];
    expect(records).toMatchObject([{ status, endedAt: expect.any(String) }]);
    if (outcome === 'cancel') expect(cancel).toHaveBeenCalledWith('caller cancelled');
    expect(JSON.stringify(records)).not.toContain('private-provider-key');
  });
  test('captures complete generated exchanges and failures without transport secrets', async () => {
    const records: ModelExchange[] = [];
    const secret = 'private-provider-credential';
    const result: LanguageModelGenerateResult = {
      ...generateResult,
      content: [
        {
          type: 'text',
          text: '{"answer":42}',
          providerMetadata: { transport: { authorization: secret } },
        },
        { type: 'source', sourceType: 'url', id: 'source-1', url: 'https://example.com/evidence' },
        { type: 'tool-result', toolCallId: 'tool-1', toolName: 'lookup', result: { found: true } },
        { type: 'reasoning', text: 'Checked the premises.' },
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'lookup',
          input: '{"query":"full input"}',
        },
      ],
      request: { body: secret },
      response: { headers: { authorization: secret } },
    };
    const model = fakeModel(result);
    const params: Parameters<LanguageModelV3['doGenerate']>[0] = {
      prompt: [
        {
          role: 'system',
          content: 'Complete instructions',
          providerOptions: { transport: { apiKey: secret } },
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Full prompt',
              providerOptions: { transport: { authorization: secret } },
            },
          ],
        },
      ],
      headers: { authorization: secret },
      responseFormat: { type: 'json', name: 'answer', schema: { type: 'object' } },
    };
    await withModelExchanges(records, async () => {
      const wrapped = meterWorkflowLanguageModel(model, {
        model: 'fixture',
        provider: 'openrouter',
        slot: 'lesson',
        reasoningEffort: 'high',
      });
      expect(await wrapped.doGenerate(params)).toBe(result);
      const failure = new Error(secret);
      failure.name = secret;
      vi.mocked(model.doGenerate).mockRejectedValueOnce(failure);
      await expect(wrapped.doGenerate(params)).rejects.toBe(failure);
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: 'openrouter',
      model: 'fixture',
      slot: 'lesson',
      reasoningEffort: 'high',
      serviceTier: 'normal',
      request: {
        messages: [
          { role: 'system', content: 'Complete instructions' },
          { role: 'user', content: [{ type: 'text', text: 'Full prompt' }] },
        ],
        outputSchemaName: 'answer',
      },
      response: '{"answer":42}',
      responseContent: expect.arrayContaining([
        { type: 'source', sourceType: 'url', id: 'source-1', url: 'https://example.com/evidence' },
        { type: 'tool-result', toolCallId: 'tool-1', toolName: 'lookup', result: { found: true } },
      ]),
      reasoningSummary: 'Checked the premises.',
      toolCalls: [{ toolCallId: 'tool-1', toolName: 'lookup', input: '{"query":"full input"}' }],
      usage: { inputTokens: 12, outputTokens: 5 },
      status: 'stop',
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      latencyMs: expect.any(Number),
    });
    expect(records[1]).toMatchObject({
      status: 'error',
      error: 'Error',
      endedAt: expect.any(String),
    });
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  test('leaves unopted models unchanged and never evaluates exchange descriptions', () => {
    const model = fakeModel(generateResult);
    expect(meterWorkflowLanguageModel(model, { model: 'fixture', provider: 'openrouter' })).toBe(
      model
    );
    const describeExchange = vi.fn(() => {
      throw new Error('must stay lazy');
    });
    expect(startModelExchange(describeExchange)).toBeUndefined();
    expect(describeExchange).not.toHaveBeenCalled();
  });

  test('captures a consumed SDK stream while preserving chunks, tools and usage', async () => {
    const records: ModelExchange[] = [];
    const chunks = [
      { type: 'text-delta' as const, id: 'text', delta: 'answer' },
      {
        type: 'source' as const,
        sourceType: 'url' as const,
        id: 'source-1',
        url: 'https://example.com/evidence',
        providerMetadata: { transport: { authorization: 'private-stream-key' } },
      },
      { type: 'reasoning-delta' as const, id: 'reason', delta: 'summary' },
      { type: 'tool-call' as const, toolCallId: 'tool', toolName: 'lookup', input: '{}' },
      {
        type: 'finish' as const,
        finishReason: generateResult.finishReason,
        usage: generateResult.usage,
      },
    ];
    const model = fakeModel(generateResult);
    vi.mocked(model.doStream).mockResolvedValueOnce({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    });
    const received: unknown[] = [];
    await withModelExchanges(records, async () => {
      const result = await meterWorkflowLanguageModel(model, {
        model: 'fixture',
        provider: 'openrouter',
      }).doStream({ prompt: [] });
      for await (const chunk of result.stream) received.push(chunk);
    });
    expect(received).toEqual(chunks);
    expect(JSON.stringify(records)).not.toContain('private-stream-key');
    expect(records).toMatchObject([
      {
        response: 'answer',
        responseContent: [
          {
            type: 'source',
            sourceType: 'url',
            id: 'source-1',
            url: 'https://example.com/evidence',
          },
        ],
        reasoningSummary: 'summary',
        toolCalls: [{ toolName: 'lookup' }],
        usage: { inputTokens: 12 },
        status: 'stop',
      },
    ]);
  });
  test('normalizes fake provider usage under the active workflow attempt identity', async () => {
    const record = vi.fn(async () => undefined);
    const rawModel = fakeModel(generateResult);

    await runWithWorkflowAttemptMetering(
      {
        attemptNumber: 2,
        nodeInstanceId: 'root/research',
        record,
        runId: '11111111-1111-4111-8111-111111111111',
      },
      () =>
        meterWorkflowLanguageModel(rawModel, {
          model: 'openai/test-model',
          provider: 'openrouter',
        }).doGenerate({} as never)
    );

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      attemptNumber: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      id: expect.any(String),
      inputTokens: 12,
      model: 'openai/test-model',
      nodeInstanceId: 'root/research',
      outputTokens: 5,
      provider: 'openrouter',
      providerCost: 0.0042,
      reasoningTokens: 2,
      runId: '11111111-1111-4111-8111-111111111111',
    });
  });

  test('is inert outside a workflow attempt and accepts partial image usage inside one', async () => {
    const record = vi.fn(async () => undefined);
    const rawModel = fakeModel(generateResult);
    expect(
      meterWorkflowLanguageModel(rawModel, {
        model: 'openai/test-model',
        provider: 'openrouter',
      })
    ).toBe(rawModel);
    await expect(
      recordWorkflowAiUsage({ model: 'image-model', provider: 'openrouter', providerCost: 0.02 })
    ).resolves.toBeUndefined();

    await runWithWorkflowAttemptMetering(
      {
        attemptNumber: 1,
        nodeInstanceId: 'root/image',
        record,
        runId: '22222222-2222-4222-8222-222222222222',
      },
      () =>
        recordWorkflowAiUsage({
          model: 'image-model',
          provider: 'openrouter',
          providerCost: 0.02,
        })
    );

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      attemptNumber: 1,
      id: expect.any(String),
      model: 'image-model',
      nodeInstanceId: 'root/image',
      provider: 'openrouter',
      providerCost: 0.02,
      runId: '22222222-2222-4222-8222-222222222222',
    });
  });
});
