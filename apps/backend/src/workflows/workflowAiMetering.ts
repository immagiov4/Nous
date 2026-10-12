import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import {
  type LanguageModel,
  type LanguageModelMiddleware,
  type ProviderMetadata,
  wrapLanguageModel,
} from 'ai';
import { isModelExchangeCaptureActive, startModelExchange } from './modelExchanges.js';

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
  readonly reportedAfterInterruption?: true;
  readonly runId: string;
}

interface WorkflowAttemptMeteringContext {
  readonly attemptNumber: number;
  readonly nodeInstanceId: string;
  readonly record: (usage: WorkflowAiUsageRecord) => Promise<void>;
  readonly runId: string;
}

const workflowAttemptMetering = new AsyncLocalStorage<WorkflowAttemptMeteringContext>();

export const currentWorkflowAttempt = () => {
  const context = workflowAttemptMetering.getStore();
  if (!context) return undefined;
  const { runId, nodeInstanceId, attemptNumber } = context;
  return { runId, nodeInstanceId, attemptNumber };
};

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

interface ExchangeModelIdentity {
  readonly model: string;
  readonly provider: 'codex' | 'openrouter';
  readonly slot?: string;
  readonly role?: string;
  readonly reasoningEffort?: string;
}

const startLanguageModelExchange = (
  identity: ExchangeModelIdentity,
  params: Parameters<LanguageModelV3['doGenerate']>[0]
) =>
  startModelExchange(() => ({
    ...identity,
    serviceTier: 'normal',
    workflow: currentWorkflowAttempt(),
    request: {
      messages: params.prompt.map(({ role, content }) => ({
        role,
        content:
          typeof content === 'string'
            ? content
            : content.map(({ providerOptions: _options, ...part }) => part),
      })),
      outputSchemaName:
        params.responseFormat?.type === 'json' ? params.responseFormat.name : undefined,
      outputSchema:
        params.responseFormat?.type === 'json' ? params.responseFormat.schema : undefined,
      tools: params.tools?.map(tool =>
        tool.type === 'function'
          ? {
              type: tool.type,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            }
          : { type: tool.type, name: tool.name, id: tool.id }
      ),
    },
  }));

type ModelStreamResult = Awaited<ReturnType<LanguageModelV3['doStream']>>;
type ModelStreamPart =
  ModelStreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;
type ExchangeCapture = NonNullable<ReturnType<typeof startModelExchange>>;

const captureStreamPart = (
  capture: ExchangeCapture,
  part: ModelStreamPart,
  identity: ExchangeModelIdentity
): void => {
  const { exchange } = capture;
  switch (part.type) {
    case 'file':
    case 'source':
    case 'tool-result':
    case 'tool-approval-request': {
      const { providerMetadata: _metadata, ...content } = part;
      exchange.responseContent ??= [];
      exchange.responseContent.push(content);
      break;
    }
    case 'text-delta':
      exchange.response = (exchange.response ?? '') + part.delta;
      break;
    case 'reasoning-delta':
      exchange.reasoningSummary = (exchange.reasoningSummary ?? '') + part.delta;
      break;
    case 'tool-call': {
      const { toolCallId, toolName, input } = part;
      exchange.toolCalls.push({ toolCallId, toolName, input });
      break;
    }
    case 'finish':
      exchange.usage = normalizeLanguageModelUsage(identity, part.usage, part.providerMetadata);
      capture.finish(part.finishReason.unified);
      break;
    case 'error':
      capture.finish('error', part.error);
      break;
  }
};

const captureModelStream = (
  result: ModelStreamResult,
  capture: ExchangeCapture,
  identity: ExchangeModelIdentity
): ModelStreamResult => {
  const reader = result.stream.getReader();
  let cancelled = false;
  return {
    ...result,
    stream: new ReadableStream<ModelStreamPart>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (cancelled) return;
          if (next.done) {
            if (capture.exchange.status === 'running') capture.finish('incomplete');
            controller.close();
          } else {
            captureStreamPart(capture, next.value, identity);
            controller.enqueue(next.value);
          }
        } catch (error) {
          if (cancelled) return;
          capture.finish('error', error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        cancelled = true;
        capture.finish('cancelled');
        await reader.cancel(reason);
      },
    }),
  };
};

export const meterWorkflowLanguageModel = (
  model: LanguageModelV3,
  identity: ExchangeModelIdentity
): LanguageModelV3 =>
  isWorkflowAiMeteringActive() || isModelExchangeCaptureActive()
    ? wrapLanguageModel({
        middleware: {
          specificationVersion: 'v3',
          wrapGenerate: async ({ doGenerate, params }) => {
            const capture = startLanguageModelExchange(identity, params);
            let result: LanguageModelGenerateResult;
            try {
              result = await doGenerate();
            } catch (error) {
              capture?.finish('error', error);
              throw error;
            }
            if (capture) {
              capture.exchange.responseContent = result.content.map(
                ({ providerMetadata: _metadata, ...part }) => part
              );
              capture.exchange.response = result.content
                .filter(part => part.type === 'text')
                .map(part => part.text)
                .join('');
              capture.exchange.reasoningSummary = result.content
                .filter(part => part.type === 'reasoning')
                .map(part => part.text)
                .join('');
              capture.exchange.toolCalls = result.content
                .filter(part => part.type === 'tool-call')
                .map(({ toolCallId, toolName, input }) => ({ toolCallId, toolName, input }));
              capture.exchange.usage = normalizeLanguageModelUsage(
                identity,
                result.usage,
                result.providerMetadata
              );
              capture.finish(result.finishReason.unified);
            }
            await recordWorkflowAiUsage(
              normalizeLanguageModelUsage(identity, result.usage, result.providerMetadata)
            );
            return result;
          },
          wrapStream: async ({ doStream, params }) => {
            const capture = startLanguageModelExchange(identity, params);
            try {
              const result = await doStream();
              return capture ? captureModelStream(result, capture, identity) : result;
            } catch (error) {
              capture?.finish('error', error);
              throw error;
            }
          },
        },
        model,
      })
    : model;
