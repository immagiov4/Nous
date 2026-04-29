import { getErrorMessage } from '../core/errorMessage.ts';

export { getErrorMessage };

export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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

const readErrorStatus = (error: unknown): number =>
  isRecord(error) && typeof error.status === 'number' ? error.status : 0;

const readErrorDetails = (error: unknown): unknown =>
  isRecord(error) ? (error as { details?: unknown }).details : undefined;

const isRetryableHttpStatus = (status: number): boolean =>
  status >= 500 || RETRYABLE_HTTP_STATUSES.has(status);

const isRetryableNetworkError = (status: number, normalizedMessage: string): boolean =>
  status === 0 &&
  RETRYABLE_NETWORK_MESSAGE_PATTERNS.some(pattern => normalizedMessage.includes(pattern));

const isRetryableModelOutputError = (details: unknown): boolean =>
  typeof details === 'string' && RETRYABLE_MODEL_OUTPUT_DETAILS.has(details);

const isRetryableOpenRouterError = (error: unknown): boolean => {
  const status = readErrorStatus(error);
  const normalizedMessage = getErrorMessage(error).toLowerCase();
  const details = readErrorDetails(error);

  return (
    isRetryableHttpStatus(status) ||
    isRetryableNetworkError(status, normalizedMessage) ||
    isRetryableModelOutputError(details) ||
    normalizedMessage.includes('rate')
  );
};

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (retries <= 0) {
      throw error;
    }

    if (!isRetryableOpenRouterError(error)) {
      throw error;
    }

    const message = getErrorMessage(error).toLowerCase();
    const status = readErrorStatus(error);

    console.warn(
      `[Nous] OpenRouter call failed (status=${status}, message="${message.slice(
        0,
        140
      )}"). Retrying in ${delay}ms... (${retries} left)`
    );
    await wait(delay);
    return retryWithBackoff(operation, retries - 1, delay * 2);
  }
}
