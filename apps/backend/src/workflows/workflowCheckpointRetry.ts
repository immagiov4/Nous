import { getOperationalRetryDelayMs } from './retryPolicy.js';
import { raceOperationWithAbort } from './workflowStepAttempt.js';

const TRANSIENT_POSTGRES_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08006',
  '08007',
  '40001',
  '40003',
  '40P01',
  '55P03',
  '57P01',
  '57P02',
  '57P03',
  'CONNECTION_CLOSED',
  'CONNECT_TIMEOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });

/**
 * Retries only failures whose PostgreSQL or transport code can succeed unchanged.
 * Schema, constraint, authentication and application errors are deliberately excluded.
 */
export const isTransientPostgresCheckpointError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code !== undefined && TRANSIENT_POSTGRES_CODES.has(code);
};

export const executeWorkflowCheckpointWithRetry = async <Result>(
  operation: () => Promise<Result>,
  signal: AbortSignal,
  options: { random?: () => number } = {}
): Promise<Result> => {
  let attemptNumber = 1;
  while (true) {
    signal.throwIfAborted();
    const result = await raceOperationWithAbort(operation, signal);
    if (result.status === 'aborted') throw signal.reason;
    if (result.status === 'succeeded') return result.value;
    if (!isTransientPostgresCheckpointError(result.error)) throw result.error;
    signal.throwIfAborted();
    const delayMs = getOperationalRetryDelayMs({
      attemptNumber,
      ...(options.random ? { random: options.random } : {}),
    });
    attemptNumber += 1;
    await waitForRetry(delayMs, signal);
  }
};
