import type { FileData } from './types';
import { getErrorMessage, isRecord } from './retry';

export * from './config';
export * from './json';
export * from './openrouter';
export * from './retry';
export type * from './types';

export const fileToDataUrl = (file: FileData): string => `data:${file.mimeType};base64,${file.data}`;

export const normalizeTtsConnectionError = (error: unknown): Error => {
  const message = getErrorMessage(error);
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';

  if (code === 'ECONNREFUSED' || message.includes('Failed to fetch')) {
    return new Error('TTS server is not running. Please start the server with "npm run dev"');
  }

  return error instanceof Error ? error : new Error(message);
};
