import { getErrorMessage } from '../core/errorMessage.ts';

export { getErrorMessage };

export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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

    const message = getErrorMessage(error).toLowerCase();
    const status = isRecord(error) && typeof error.status === 'number' ? error.status : 0;
    const isHttpRetryable = status >= 500 || status === 429 || status === 408;
    const isNetworkRetryable =
      status === 0 &&
      (message.includes('failed to fetch') ||
        message.includes('network') ||
        message.includes('networkerror') ||
        message.includes('aborted') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('econnreset') ||
        message.includes('socket hang up') ||
        message.includes('etimedout') ||
        message.includes('eai_again'));
    const details = isRecord(error) ? (error as { details?: unknown }).details : undefined;
    const isModelOutputRetryable =
      details === 'empty_stream' ||
      details === 'empty_lesson_content' ||
      details === 'invalid_json_response';
    const isRateLimitMessage = message.includes('rate');
    const isRetryable =
      isHttpRetryable || isNetworkRetryable || isModelOutputRetryable || isRateLimitMessage;

    if (!isRetryable) {
      throw error;
    }

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
