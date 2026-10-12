import { AsyncLocalStorage } from 'node:async_hooks';

export interface ModelExchange {
  provider: 'codex' | 'openrouter';
  model: string;
  slot?: string;
  role?: string;
  reasoningEffort?: string;
  serviceTier: string;
  workflow?: { runId: string; nodeInstanceId: string; attemptNumber: number };
  request: unknown;
  response?: string;
  responseContent?: unknown[];
  reasoningText?: string;
  reasoningSummary?: string;
  toolCalls: unknown[];
  usage?: unknown;
  status: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
}

const exchanges = new AsyncLocalStorage<{
  records: ModelExchange[];
  pending: Set<Promise<void>>;
}>();

/** Only synthetic real-provider harnesses enable capture; there is no environment switch. */
export const withModelExchanges = async <Result>(
  records: ModelExchange[],
  operation: () => Promise<Result>
): Promise<Result> => {
  const context = { records, pending: new Set<Promise<void>>() };
  return exchanges.run(context, async () => {
    try {
      return await operation();
    } finally {
      await Promise.all(context.pending);
    }
  });
};

export const isModelExchangeCaptureActive = (): boolean => exchanges.getStore() !== undefined;

/** SQL notifications can originate outside the harness's async descendants. */
export const bindModelExchangeCapture = <Argument>(
  callback: (argument: Argument) => void
): ((argument: Argument) => void) => {
  const context = exchanges.getStore();
  return context ? argument => exchanges.run(context, () => callback(argument)) : callback;
};

/** Lazily select model content, never transport objects, credentials or raw errors. */
export const startModelExchange = (
  describe: () => Omit<ModelExchange, 'startedAt' | 'status' | 'toolCalls'>
): { exchange: ModelExchange; finish: (status: string, error?: unknown) => void } | undefined => {
  const context = exchanges.getStore();
  if (!context) return undefined;
  const started = performance.now();
  const exchange: ModelExchange = {
    ...describe(),
    startedAt: new Date().toISOString(),
    status: 'running',
    toolCalls: [],
  };
  context.records.push(exchange);
  let complete!: () => void;
  const pending = new Promise<void>(resolve => {
    complete = resolve;
  });
  context.pending.add(pending);
  return {
    exchange,
    finish: (status, error) => {
      exchange.status = status;
      exchange.endedAt = new Date().toISOString();
      exchange.latencyMs = performance.now() - started;
      if (error !== undefined)
        exchange.error = error instanceof Error ? error.constructor.name : 'UnknownError';
      context.pending.delete(pending);
      complete();
    },
  };
};
