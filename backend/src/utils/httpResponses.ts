import type { Response } from 'express';

import { getErrorMessage } from './errors.js';

export function sendErrorResponse(
  response: Response,
  statusCode: number,
  error: unknown,
  fallbackMessage: string,
): void {
  response.status(statusCode).json({
    success: false,
    error: getErrorMessage(error, fallbackMessage),
  });
}
