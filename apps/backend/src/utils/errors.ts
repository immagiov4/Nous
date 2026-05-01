type ErrorLike = {
  cause?: unknown;
  code?: unknown;
  message?: unknown;
};

export interface NormalizedError {
  cause?: unknown;
  code?: string;
  message: string;
}

function getNestedErrorLike(error: unknown): ErrorLike | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  return error as ErrorLike;
}

function normalizeError(error: unknown, fallbackMessage = 'Unknown error'): NormalizedError {
  if (error instanceof Error) {
    const errorLike = error as ErrorLike;

    return {
      cause: errorLike.cause,
      code: typeof errorLike.code === 'string' ? errorLike.code : undefined,
      message: error.message || fallbackMessage,
    };
  }

  if (typeof error === 'string' && error.length > 0) {
    return { message: error };
  }

  const errorLike = getNestedErrorLike(error);

  if (errorLike) {
    const code = typeof errorLike.code === 'string' ? errorLike.code : undefined;
    const message =
      typeof errorLike.message === 'string' && errorLike.message.length > 0
        ? errorLike.message
        : fallbackMessage;

    return {
      cause: errorLike.cause,
      code,
      message,
    };
  }

  return { message: fallbackMessage };
}

export function getErrorMessage(error: unknown, fallbackMessage = 'Unknown error'): string {
  return normalizeError(error, fallbackMessage).message;
}
