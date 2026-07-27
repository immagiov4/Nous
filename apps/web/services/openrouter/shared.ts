import { isRecord } from '../../utils/records.ts';
import { clipText } from '../../utils/text.ts';
import { getErrorMessage } from '../core/errorMessage.ts';
import {
  decodeTextBase64,
  detectStoredSourceFileKind,
  isPdfFileData,
} from '../projects/projectSource.ts';
import { isOpenRouterBase64MediaInlineSafe } from './payloadLimits.ts';
import type { FileData } from './types.ts';

export * from './client.ts';
export * from './config.ts';
export * from './json.ts';
export * from './retry.ts';
export type * from './types.ts';
export { getErrorMessage };

export const fileToDataUrl = (file: FileData): string =>
  `data:${file.mimeType};base64,${file.data}`;

export const isPdfFile = isPdfFileData;

const MAX_DIRECT_TEXT_SOURCE_CHARS = 48_000;

const buildOversizedDocumentNotice = (file: FileData, prompt: string): string => `Documento: ${
  file.name
}

${prompt}

Nota importante: il file originale e troppo grande per essere allegato direttamente alla richiesta.
Usa solo il contesto testuale gia presente nel prompt e non presumere dettagli non inclusi.`;

export const buildDocumentInputContent = (file: FileData, prompt: string) => {
  const fileKind = detectStoredSourceFileKind(file);

  if (fileKind === 'text') {
    return `Sorgente: ${file.name}

${prompt}

CONTENUTO SORGENTE:
${clipText(decodeTextBase64(file.data), MAX_DIRECT_TEXT_SOURCE_CHARS, '[contenuto sorgente troncato]')}`;
  }

  if (!isOpenRouterBase64MediaInlineSafe(file.data, file.mimeType || 'application/octet-stream')) {
    return buildOversizedDocumentNotice(file, prompt);
  }

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

  return [
    { type: 'image_url' as const, image_url: { url: fileToDataUrl(file) } },
    { type: 'text' as const, text: prompt },
  ];
};

export const normalizeTtsConnectionError = (error: unknown): Error => {
  const message = getErrorMessage(error);
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';

  if (code === 'ECONNREFUSED' || message.includes('Failed to fetch')) {
    return new Error('TTS server is not running. Please start the server with "bun run dev"');
  }

  return error instanceof Error ? error : new Error(message);
};
