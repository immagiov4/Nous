import type { ProjectLessonVisual } from './projectAsset';

export const ARTIFACT_DRAFT_SLOT_ID = 'artifact-draft';

export type ArtifactDraftWorkflowStage = 'finalizing' | 'planning' | 'rendering';
export type ArtifactDraftWorkflowStatus = 'completed' | 'failed' | 'queued' | 'running';

export interface ArtifactDraftWorkflowResult {
  readonly visual: ProjectLessonVisual | null;
}

export interface ArtifactDraftWorkflowSnapshot {
  readonly attempt?: number;
  readonly createdAt: string;
  readonly errorCode?: string;
  readonly id: string;
  readonly projectId: string;
  readonly result?: ArtifactDraftWorkflowResult;
  readonly retrying: boolean;
  readonly sectionId: string;
  readonly stage: ArtifactDraftWorkflowStage;
  readonly startedAt?: string;
  readonly status: ArtifactDraftWorkflowStatus;
  readonly updatedAt: string;
}

export interface ArtifactDraftWorkflowResponse {
  readonly created?: boolean;
  readonly error?: string;
  readonly job?: ArtifactDraftWorkflowSnapshot;
  readonly success: boolean;
}
