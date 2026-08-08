import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import {
  type LanguageModel,
  type LanguageModelMiddleware,
  type ProviderMetadata,
  wrapLanguageModel,
} from 'ai';

type LanguageModelV3 = Extract<LanguageModel, { readonly specificationVersion: 'v3' }>;
type LanguageModelGenerateResult = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware['wrapGenerate']>>
>;

export interface WorkflowAiUsage {
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly model: string;
  readonly outputTokens?: number;
  readonly provider: string;
  readonly providerCost?: number;
  readonly reasoningTokens?: number;
}

export interface WorkflowAiUsageRecord extends WorkflowAiUsage {
  readonly attemptNumber: number;
  readonly id: string;
  readonly nodeInstanceId: string;
  readonly runId: string;
}

interface WorkflowAttemptMeteringContext {
  readonly attemptNumber: number;
  readonly nodeInstanceId: string;
  readonly record: (usage: WorkflowAiUsageRecord) => Promise<void>;
  readonly runId: string;
}

const workflowAttemptMetering = new AsyncLocalStorage<WorkflowAttemptMeteringContext>();

export const isWorkflowAiMeteringActive = (): boolean =>
  workflowAttemptMetering.getStore() !== undefined;

const optionalNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const openRouterCost = (metadata: ProviderMetadata | undefined): number | undefined => {
  const usage = metadata?.openrouter?.usage;
  return typeof usage === 'object' && usage !== null && !Array.isArray(usage)
    ? optionalNonNegativeNumber(usage.cost)
    : undefined;
};

const normalizeLanguageModelUsage = (
  identity: { readonly model: string; readonly provider: string },
  usage: LanguageModelGenerateResult['usage'],
  providerMetadata: ProviderMetadata | undefined
): WorkflowAiUsage => {
  const cacheReadTokens = optionalNonNegativeNumber(usage.inputTokens.cacheRead);
  const cacheWriteTokens = optionalNonNegativeNumber(usage.inputTokens.cacheWrite);
  const inputTokens = optionalNonNegativeNumber(usage.inputTokens.total);
  const outputTokens = optionalNonNegativeNumber(usage.outputTokens.total);
  const providerCost = openRouterCost(providerMetadata);
  const reasoningTokens = optionalNonNegativeNumber(usage.outputTokens.reasoning);

  return {
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    model: identity.model,
    ...(outputTokens === undefined ? {} : { outputTokens }),
    provider: identity.provider,
    ...(providerCost === undefined ? {} : { providerCost }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
};

export const runWithWorkflowAttemptMetering = <Result>(
  context: WorkflowAttemptMeteringContext,
  operation: () => Result
): Result => workflowAttemptMetering.run(Object.freeze({ ...context }), operation);

export const recordWorkflowAiUsage = async (usage: WorkflowAiUsage): Promise<void> => {
  const context = workflowAttemptMetering.getStore();
  if (!context) return;
  await context.record({
    ...usage,
    attemptNumber: context.attemptNumber,
    id: randomUUID(),
    nodeInstanceId: context.nodeInstanceId,
    runId: context.runId,
  });
};

export const meterWorkflowLanguageModel = (
  model: LanguageModelV3,
  identity: { readonly model: string; readonly provider: string }
): LanguageModelV3 =>
  isWorkflowAiMeteringActive()
    ? wrapLanguageModel({
        middleware: {
          specificationVersion: 'v3',
          wrapGenerate: async ({ doGenerate }) => {
            const result = await doGenerate();
            await recordWorkflowAiUsage(
              normalizeLanguageModelUsage(identity, result.usage, result.providerMetadata)
            );
            return result;
          },
        },
        model,
      })
    : model;
