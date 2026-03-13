import type { FileData } from './types';
import { getErrorMessage, isRecord } from './retry';

export * from './config';
export * from './json';
export * from './openrouter';
export * from './retry';
export type * from './types';

export const fileToDataUrl = (file: FileData): string => `data:${file.mimeType};base64,${file.data}`;

export const isPdfFile = (file: Pick<FileData, 'name' | 'mimeType'> | null | undefined): boolean =>
  Boolean(file && (file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')));

export const buildDocumentInputContent = (file: FileData, prompt: string) =>
  isPdfFile(file)
    ? [
        { type: 'text' as const, text: prompt },
        {
          type: 'file' as const,
          file: {
            filename: file.name,
            file_data: fileToDataUrl(file),
          },
        },
      ]
    : [
        { type: 'image_url' as const, image_url: { url: fileToDataUrl(file) } },
        { type: 'text' as const, text: prompt },
      ];

export const normalizeTtsConnectionError = (error: unknown): Error => {
  const message = getErrorMessage(error);
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';

  if (code === 'ECONNREFUSED' || message.includes('Failed to fetch')) {
    return new Error('TTS server is not running. Please start the server with "npm run dev"');
  }

  return error instanceof Error ? error : new Error(message);
};
