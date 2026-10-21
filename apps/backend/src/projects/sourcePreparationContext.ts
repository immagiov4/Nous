import type { SourcePreparationProgress } from '@shared/sourcePreparation';
import type { PdfTranscriptionPool } from '../services/pdfTranscriptionPool.js';
import type { ProjectSnapshot } from './types.js';

/** One context per collection, shared by every per-file preparation step. */
export interface SourcePreparationContext {
  pdfTranscriptionPool?: PdfTranscriptionPool;
  checkpointPreparedSources?: (snapshot: ProjectSnapshot) => void;
  previousScannedPages?: number;
  userId: string;
  uploadId: string;
  projectId: string;
  signal: AbortSignal;
  reportProgress: (progress: SourcePreparationProgress) => void;
}

export type SourcePreparationJobContext = Pick<
  SourcePreparationContext,
  'signal' | 'reportProgress'
>;
