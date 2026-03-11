export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
};

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
    const isRetryable = status >= 500 || status === 429 || message.includes('rate');

    if (!isRetryable) {
      throw error;
    }

    console.warn(`API Error ${status}. Retrying in ${delay}ms... (${retries} left)`);
    await wait(delay);
    return retryWithBackoff(operation, retries - 1, delay * 2);
  }
}
