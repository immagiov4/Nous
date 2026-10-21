import type { SourceArchivePdfWarningReason } from './sourceArchiveWarnings';

/** Progress belongs to the collection job; individual steps report their own N/M. */
export interface SourcePreparationProgress {
  step: 'upload' | 'expansion' | 'extraction' | 'pdf-transcription' | 'persistence';
  completed: number;
  total: number;
  documentName?: string;
  failedPages?: number[];
  failures?: { documentName: string; pageNumber?: number }[];
  reducedQuality?: { from: number; to: number };
}

export const SOURCE_PREPARATION_INTERRUPTED_MESSAGE =
  'La preparazione delle fonti è stata interrotta. Riprova il caricamento.';

export const SOURCE_STAGING_UNAVAILABLE_CODE = 'SOURCE_STAGING_UNAVAILABLE';
export const SOURCE_STAGING_UNAVAILABLE_MESSAGE =
  'Il server deve configurare lo spazio temporaneo su disco prima di caricare le fonti.';

export const SOURCE_INGESTION_REQUIRED_CODE = 'SOURCE_INGESTION_REQUIRED';
export const SOURCE_INGESTION_REQUIRED_MESSAGE =
  'Ricarica la pagina e aggiungi nuovamente le fonti.';

export const SOURCE_PREPARATION_UNUSABLE_CODE = 'SOURCE_PREPARATION_UNUSABLE';
export const SOURCE_PREPARATION_UNUSABLE_MESSAGE =
  'Nessuna delle fonti contiene testo utilizzabile.';
export interface SourcePreparationFailure {
  failedPages?: number[];
  name: string;
  reason: SourceArchivePdfWarningReason;
}
export const SOURCE_PREPARATION_FAILURE_MESSAGES = {
  'no-usable-text': 'Questa fonte non contiene testo utilizzabile.',
  'parser-failed': 'Non è stato possibile leggere questa fonte.',
  'safety-limit': 'Questa fonte supera il limite di elaborazione.',
  timeout: 'La lettura di questa fonte ha superato il tempo disponibile.',
} as const satisfies Record<SourceArchivePdfWarningReason, string>;

export const SOURCE_PREPARATION_CANCELLED_CODE = 'SOURCE_PREPARATION_CANCELLED';
export const SOURCE_PREPARATION_CANCELLED_MESSAGE =
  'La preparazione delle fonti è stata annullata.';

export const SOURCE_PREPARATION_CONFLICT_MESSAGE =
  'È già in corso la preparazione di altre fonti per questo corso. Attendi che finisca e riprova.';

export const SOURCE_PREPARATION_CONFLICT_CODE = 'SOURCE_PREPARATION_CONFLICT';
