import { getErrorMessage } from '../utils/errors.js';

const DEFAULT_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1_000;
const RETRY_BACKOFF_MULTIPLIER = 2;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);
const RETRYABLE_MODEL_OUTPUT_DETAILS = new Set([
  'empty_stream',
  'empty_lesson_content',
  'invalid_json_response',
]);
const RETRYABLE_NETWORK_MESSAGE_PATTERNS = [
  'failed to fetch',
  'network',
  'networkerror',
  'aborted',
  'timeout',
  'timed out',
  'econnreset',
  'socket hang up',
  'etimedout',
  'eai_again',
];

const readErrorField = (error: unknown, field: string): unknown =>
  typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;

const isRetryableProviderError = (error: unknown): boolean => {
  const status = readErrorField(error, 'status');
  const numericStatus = typeof status === 'number' ? status : 0;
  const message = getErrorMessage(error).toLowerCase();
  return (
    numericStatus >= 500 ||
    RETRYABLE_HTTP_STATUSES.has(numericStatus) ||
    (numericStatus === 0 &&
      RETRYABLE_NETWORK_MESSAGE_PATTERNS.some(pattern => message.includes(pattern))) ||
    RETRYABLE_MODEL_OUTPUT_DETAILS.has(String(readErrorField(error, 'details'))) ||
    message.includes('rate')
  );
};

const waitForRetry = (delay: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export const retryProviderCall = async <T>(
  operation: () => Promise<T>,
  {
    delay = INITIAL_RETRY_DELAY_MS,
    retries = DEFAULT_RETRY_ATTEMPTS,
    signal,
  }: { delay?: number; retries?: number; signal: AbortSignal }
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (signal.aborted || retries <= 0 || !isRetryableProviderError(error)) throw error;
    await waitForRetry(delay, signal);
    return retryProviderCall(operation, {
      delay: delay * RETRY_BACKOFF_MULTIPLIER,
      retries: retries - 1,
      signal,
    });
  }
};
