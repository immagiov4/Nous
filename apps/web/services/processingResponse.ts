import {
  PDF_SCANNED_PAGE_LIMIT_CODE,
  PDF_SCANNED_PAGE_LIMIT_MESSAGE,
  type PdfTranscriptionProgress,
} from '@shared/pdfTranscription';
import { translateUiMessage as t } from '../i18n/uiMessages.ts';

export class PdfTranscriptionError extends Error {
  constructor(readonly failedPages: number[]) {
    super(
      t('Trascrizione non riuscita per le pagine: {pages}.', { pages: failedPages.join(', ') })
    );
    this.name = 'PdfTranscriptionError';
  }
}

export const readProcessingResponse = async <T>(
  response: Response,
  onProgress?: (progress: PdfTranscriptionProgress) => void
): Promise<T> => {
  if (!response.headers?.get('content-type')?.includes('application/x-ndjson'))
    return response.json();
  if (!response.body) throw new Error(t('Risposta di elaborazione incompleta.'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: T | undefined;
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as {
      type: string;
      progress: PdfTranscriptionProgress;
      result: T;
      error?: string;
      code?: string;
      failedPages?: number[];
    };
    if (event.type === 'progress') onProgress?.(event.progress);
    if (event.type === 'result') result = event.result;
    if (event.type === 'error' && event.code === PDF_SCANNED_PAGE_LIMIT_CODE)
      throw new Error(t(PDF_SCANNED_PAGE_LIMIT_MESSAGE));
    if (event.type === 'error')
      throw event.failedPages?.length
        ? new PdfTranscriptionError(event.failedPages)
        : new Error(t('Preparazione del documento non riuscita.'));
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    consumeLine(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error(t('Risposta di elaborazione incompleta.'));
  return result;
};

/** Uses the existing processing message surface for progress and explicit missing pages. */
export const formatPdfTranscriptionProgress = (progress: PdfTranscriptionProgress): string =>
  [
    t('Trascrizione pagine scansionate {completed}/{total}', {
      completed: progress.completed,
      total: progress.total,
    }),
    ...(progress.reducedQuality
      ? [t('Pagine {from}–{to} trascritte in qualità ridotta.', progress.reducedQuality)]
      : []),
    ...(progress.failures || []).map(failure =>
      t('{file}, pagina {page}: non trascritta.', {
        file: failure.documentName,
        page: failure.pageNumber,
      })
    ),
  ].join('\n');
