export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
};

export interface ErrorDiagnostic {
  cause?: string;
  message: string;
  name: string;
  stack?: string;
}

export const getErrorDiagnostic = (error: unknown): ErrorDiagnostic => {
  if (!(error instanceof Error)) {
    return {
      message: getErrorMessage(error),
      name: typeof error,
    };
  }

  const cause =
    error.cause instanceof Error
      ? `${error.cause.name}: ${error.cause.message}`
      : typeof error.cause === 'string'
        ? error.cause
        : undefined;

  return {
    ...(cause ? { cause } : {}),
    message: error.message,
    name: error.name,
    ...(error.stack ? { stack: error.stack } : {}),
  };
};
