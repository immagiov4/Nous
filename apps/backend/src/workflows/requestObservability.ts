import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

type RequestPhase = 'auth' | 'poolWait' | 'query' | 'normalization' | 'serialization';

interface RequestObservabilityContext {
  readonly correlationId: string;
  readonly timings: Record<string, number>;
}

const contextStorage = new AsyncLocalStorage<RequestObservabilityContext>();

export const createCorrelationId = (): string => randomUUID();

export const runWithCorrelationId = <Result>(
  correlationId: string,
  callback: () => Result
): Result => contextStorage.run({ correlationId, timings: {} }, callback);

export const getCorrelationId = (): string | undefined => contextStorage.getStore()?.correlationId;

/** Durations only; callers use fixed phase names, never request content. */
export const recordRequestTiming = (phase: RequestPhase, durationMs: number): void => {
  const timings = contextStorage.getStore()?.timings;
  if (timings) timings[phase] = (timings[phase] ?? 0) + durationMs;
};

export const getRequestTimings = (): Record<string, number> | undefined =>
  contextStorage.getStore()?.timings;

export const measureRequestPhase = async <T>(
  phase: RequestPhase,
  work: () => PromiseLike<T>
): Promise<T> => {
  const started = performance.now();
  try {
    return await work();
  } finally {
    recordRequestTiming(phase, performance.now() - started);
  }
};
