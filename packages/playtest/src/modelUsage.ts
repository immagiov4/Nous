import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Api,
  type AssistantMessageEventStream,
  getApiProvider,
  type Model,
  registerApiProvider,
  type Usage,
} from '@mariozechner/pi-ai';

type Phase = 'learner' | 'judge';
type ReportedUsage = Usage & { responses: number };
export type ModelUsage = {
  currency: 'USD';
  source: 'pi';
  learner: ReportedUsage;
  judge: ReportedUsage;
  total: ReportedUsage;
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
  };
}

/** Async scope attributes concurrent stories independently, including unsuccessful responses. */
export function withModelUsage<T>(report: ModelUsage, phase: Phase, work: () => T): T {
  return scope.run({ report, phase }, work);
}

function monitor(stream: AssistantMessageEventStream): AssistantMessageEventStream {
  const current = scope.getStore();
  if (current) {
    // result() observes the final message without consuming events needed by Pi's agent.
    void stream.result().then(
      message => {
        for (const target of [current.report[current.phase], current.report.total]) {
          target.responses++;
          for (const field of [
            'input',
            'output',
            'cacheRead',
            'cacheWrite',
            'totalTokens',
          ] as const)
            target[field] += message.usage[field];
          for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
            target.cost[field] += message.usage.cost[field];
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
export function meterModel(model: Model<Api>): Model<Api> {
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
          monitor(provider.stream({ ...selected, api: originalApi }, context, options)),
        streamSimple: (selected, context, options) =>
          monitor(provider.streamSimple({ ...selected, api: originalApi }, context, options)),
      },
      api
    );
  }
  return { ...model, api };
}
