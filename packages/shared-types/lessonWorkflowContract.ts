export type LessonWorkflowStage = 'sources' | 'structure' | 'drafting' | 'quiz' | 'verification';

export type LessonWorkflowStatus = 'completed' | 'failed' | 'queued' | 'running';

export interface LessonWorkflowFailure {
  code: string;
  kind: 'corrective' | 'operational' | 'permanent';
}

export interface LessonWorkflowWarning {
  code:
    | 'lesson_learning_aids_unavailable'
    | 'lesson_pdf_image_extraction_incomplete'
    | 'lesson_visual_generation_incomplete'
    | 'lesson_youtube_research_unavailable';
  pageNumber?: number;
  sourceId?: string;
  stage: 'aids' | 'sources' | 'visuals' | 'youtube';
  subjectId?: string;
}

export interface LessonWorkflowResult {
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
  warnings: LessonWorkflowWarning[];
}

export interface LessonWorkflowSnapshot {
  attempt?: number;
  createdAt: string;
  errorCode?: string;
  failure?: LessonWorkflowFailure;
  id: string;
  projectId: string;
  retrying: boolean;
  result?: LessonWorkflowResult;
  sectionId: string;
  stage: LessonWorkflowStage;
  startedAt?: string;
  status: LessonWorkflowStatus;
  updatedAt: string;
}

export interface LessonWorkflowResponse {
  error?: string;
  job?: LessonWorkflowSnapshot;
  success: boolean;
}
