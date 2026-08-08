export type CourseWorkflowStage =
  | 'sources'
  | 'structure'
  | 'drafting'
  | 'quiz'
  | 'verification'
  | 'ready';

export type CourseWorkflowStatus = 'completed' | 'failed' | 'queued' | 'running';

export interface CourseWorkflowResult {
  firstSectionId: string;
  projectId: string;
  projectRevision: number;
}

export interface CourseWorkflowSnapshot {
  attempt?: number;
  createdAt: string;
  errorCode?: string;
  id: string;
  mode: 'document' | 'learn';
  projectId: string;
  retrying: boolean;
  result?: CourseWorkflowResult;
  stage: CourseWorkflowStage;
  startedAt?: string;
  status: CourseWorkflowStatus;
  updatedAt: string;
}

export interface CourseWorkflowResponse {
  error?: string;
  job?: CourseWorkflowSnapshot;
  success: boolean;
}
