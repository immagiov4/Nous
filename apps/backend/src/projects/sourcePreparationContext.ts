import type { SourcePreparationProgress } from '@shared/sourcePreparation';

/** One context per collection, shared by every per-file preparation step. */
export interface SourcePreparationContext {
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
