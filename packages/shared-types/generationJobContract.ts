export type GenerationJobStatus = 'completed' | 'failed' | 'queued' | 'running';

export interface DurableLessonGenerationResult {
  alreadyCompleted?: boolean;
  content: string;
  contentBlocks: unknown[];
  documentAssets?: Record<string, unknown> | null;
  generatedVisuals: unknown[];
  imageRefs: unknown[];
  learningAids: unknown[];
  projectId: string;
  projectRevision?: number;
  quiz: unknown[];
  researchDossier?: Record<string, unknown>;
  sectionId: string;
  visualPlanningDecision?: unknown;
}

export interface GenerationJobWire {
  errorCode?: string;
  id: string;
  kind: 'image' | 'lesson';
  payload?: unknown;
  result?: unknown;
  status: GenerationJobStatus;
}

export interface GenerationJobResponse {
  error?: string;
  job?: GenerationJobWire;
  success: boolean;
}
