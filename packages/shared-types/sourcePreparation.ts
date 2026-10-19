/** Progress belongs to the collection job; individual steps report their own N/M. */
export interface SourcePreparationProgress {
  step: 'upload' | 'expansion' | 'compression' | 'extraction' | 'pdf-transcription' | 'persistence';
  completed: number;
  total: number;
  documentName?: string;
  failedPages?: number[];
  failures?: { documentName: string; pageNumber?: number }[];
  reducedQuality?: { from: number; to: number };
}

export const SOURCE_PREPARATION_INTERRUPTED_CODE = 'SOURCE_PREPARATION_INTERRUPTED';
export const SOURCE_PREPARATION_INTERRUPTED_MESSAGE =
  'La preparazione delle fonti è stata interrotta. Riprova il caricamento.';

export const SOURCE_STAGING_UNAVAILABLE_CODE = 'SOURCE_STAGING_UNAVAILABLE';
export const SOURCE_STAGING_UNAVAILABLE_MESSAGE =
  'Il server deve configurare lo spazio temporaneo su disco prima di caricare le fonti.';
