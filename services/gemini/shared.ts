import type { FileData } from './types.ts';
import { decodeTextBase64, detectStoredSourceFileKind, isPdfFileData } from '../projectSource.ts';
import { getErrorMessage, isRecord } from './retry.ts';

export * from './config.ts';
export * from './json.ts';
export * from './openrouter.ts';
export * from './retry.ts';
export type * from './types.ts';

export const fileToDataUrl = (file: FileData): string => `data:${file.mimeType};base64,${file.data}`;

export const isPdfFile = isPdfFileData;

export const buildDocumentInputContent = (file: FileData, prompt: string) => {
  const fileKind = detectStoredSourceFileKind(file);

  if (fileKind === 'pdf') {
    return [
      { type: 'text' as const, text: prompt },
      {
        type: 'file' as const,
        file: {
          filename: file.name,
          file_data: fileToDataUrl(file),
        },
      },
    ];
  }

  if (fileKind === 'text') {
    return `Sorgente: ${file.name}

${prompt}

CONTENUTO SORGENTE:
${decodeTextBase64(file.data)}`;
  }

  return [
    { type: 'image_url' as const, image_url: { url: fileToDataUrl(file) } },
    { type: 'text' as const, text: prompt },
  ];
};

export const normalizeTtsConnectionError = (error: unknown): Error => {
  const message = getErrorMessage(error);
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';

  if (code === 'ECONNREFUSED' || message.includes('Failed to fetch')) {
    return new Error('TTS server is not running. Please start the server with "npm run dev"');
  }

  return error instanceof Error ? error : new Error(message);
};
