import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { describe, expect, test, vi } from 'vitest';

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
