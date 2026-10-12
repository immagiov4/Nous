import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Api,
  type AssistantMessageEventStream,
  calculateCost,
  getApiProvider,
  type Model,
  registerApiProvider,
  type Usage,
} from '@mariozechner/pi-ai';

import * as z from 'zod';

export const TOKENS_PER_MILLION = 1_000_000;
export type PricedModel<A extends Api = Api> = Model<A> & { pricingOverrides?: unknown[] };
const priceSchema = z.string().trim().min(1).pipe(z.coerce.number<string>().nonnegative());
const overrideSchema = z.strictObject({
  min_prompt_tokens: z.number().int().nonnegative(),
  prompt: priceSchema.optional(),
  completion: priceSchema.optional(),
  input_cache_read: priceSchema.optional(),
  input_cache_write: priceSchema.optional(),
  // Pi requests the default cache TTL; this separate SKU does not price its cache writes.
  input_cache_write_1h: priceSchema.optional(),
});

type Phase = 'learner' | 'judge';
type ReportedUsage = Usage & { responses: number };
export type ModelUsage = {
  currency: 'USD';
  source: 'pi';
  learner: ReportedUsage;
  judge: ReportedUsage;
  total: ReportedUsage;
  requests: { phase: Phase; usage: Usage; costEstimated?: true }[];
  costEstimated?: true;
};
const scope = new AsyncLocalStorage<{ report: ModelUsage; phase: Phase }>();

function emptyUsage(): ReportedUsage {
  return {
    responses: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createModelUsage(): ModelUsage {
  return {
    currency: 'USD',
    source: 'pi',
    learner: emptyUsage(),
    judge: emptyUsage(),
    total: emptyUsage(),
    requests: [],
  };
}

/** Async scope attributes concurrent stories independently, including unsuccessful responses. */
export function withModelUsage<T>(report: ModelUsage, phase: Phase, work: () => T): T {
  return scope.run({ report, phase }, work);
}

/** Catalogue conditions apply to each complete prompt, including cache reads and writes. */
function requestCost(model: PricedModel, usage: Usage): { usage: Usage; costEstimated?: true } {
  if (!model.pricingOverrides?.length) return { usage };
  const rates = { ...model.cost };
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let costEstimated: true | undefined;
  for (const override of model.pricingOverrides) {
    const parsed = overrideSchema.safeParse(override);
    if (!parsed.success) {
      costEstimated = true;
      break;
    }
    // OpenRouter defines min_prompt_tokens as a strict lower bound.
    if (promptTokens <= parsed.data.min_prompt_tokens) continue;
    for (const [catalogueKey, costKey] of [
      ['prompt', 'input'],
      ['completion', 'output'],
      ['input_cache_read', 'cacheRead'],
      ['input_cache_write', 'cacheWrite'],
    ] as const) {
      const rate = parsed.data[catalogueKey];
      if (rate !== undefined) rates[costKey] = rate * TOKENS_PER_MILLION;
    }
  }
  const pricedUsage = { ...usage, cost: { ...usage.cost } };
  calculateCost({ ...model, cost: costEstimated ? model.cost : rates }, pricedUsage);
  return { usage: pricedUsage, ...(costEstimated ? { costEstimated } : {}) };
}

function monitor(
  stream: AssistantMessageEventStream,
  model: PricedModel
): AssistantMessageEventStream {
  const current = scope.getStore();
  if (current) {
    // result() observes the final message without consuming events needed by Pi's agent.
    void stream.result().then(
      message => {
        const request = requestCost(model, message.usage);
        current.report.requests.push({ phase: current.phase, ...request });
        if (request.costEstimated) current.report.costEstimated = true;
        for (const target of [current.report[current.phase], current.report.total]) {
          target.responses++;
          for (const field of [
            'input',
            'output',
            'cacheRead',
            'cacheWrite',
            'totalTokens',
          ] as const)
            target[field] += request.usage[field];
          for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
            target.cost[field] += request.usage.cost[field];
        }
      },
      () => {
        // Pi's consumer owns stream errors; a rejected stream has no final usage to record.
      }
    );
  }
  return stream;
}

/** A separate API registration preserves the provider stream and the judge's existing instructions. */
export function meterModel(model: PricedModel): Model<Api> {
  if (!scope.getStore()) return model;
  const api = `playtest-usage:${model.api}`;
  if (!getApiProvider(api)) {
    const provider = getApiProvider(model.api);
    if (!provider) throw new Error(`No Pi stream provider for ${model.api}.`);
    const originalApi = model.api;
    registerApiProvider(
      {
        api,
        stream: (selected, context, options) =>
          monitor(provider.stream({ ...selected, api: originalApi }, context, options), selected),
        streamSimple: (selected, context, options) =>
          monitor(
            provider.streamSimple({ ...selected, api: originalApi }, context, options),
            selected
          ),
      },
      api
    );
  }
  return { ...model, api };
}
