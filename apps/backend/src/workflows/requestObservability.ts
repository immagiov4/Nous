import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface RequestObservabilityContext {
  readonly correlationId: string;
}

const contextStorage = new AsyncLocalStorage<RequestObservabilityContext>();

export const createCorrelationId = (): string => randomUUID();

export const runWithCorrelationId = <Result>(
  correlationId: string,
  callback: () => Result
): Result => contextStorage.run({ correlationId }, callback);

export const getCorrelationId = (): string | undefined => contextStorage.getStore()?.correlationId;
