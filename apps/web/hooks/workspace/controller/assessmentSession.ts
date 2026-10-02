import type { ProjectSourceWarning } from '../../../types.ts';

export interface HomeChatStartResult {
  errorMessage?: string;
  outcome:
    | 'abandoned'
    | 'assessment-complete'
    | 'continued'
    | 'failed'
    | 'imported'
    | 'noop'
    | 'planned';
  sourceWarnings?: ProjectSourceWarning[];
}

export interface PendingAssessmentInterviewRun {
  readonly pollingAbortController?: AbortController;
  readonly projectId: string;
  readonly runId: Promise<string | null>;
  readonly startRequestAbortController?: AbortController;
}

export interface PendingWorkspaceOpen {
  readonly outcome: Promise<boolean>;
  readonly projectId: string;
  readonly resolve: (opened: boolean) => void;
}

export interface AssessmentWorkspaceOwnership {
  readonly adoptedProjectIds: Set<string>;
  draftCleanupPromise: Promise<void> | null;
  draftProjectId: string | null;
  readonly pendingOpenProjects: Map<number, PendingWorkspaceOpen>;
  readonly requestToken: symbol;
  requiresCancellationRetry: boolean;
}

export interface PendingCancelledDraftCleanup {
  readonly ownership: AssessmentWorkspaceOwnership;
  readonly projectId: string;
}

/**
 * Mutable interview runtime shared by every controller instance of one workspace.
 * It must outlive React renders: cancellation, draft cleanup and late-start races
 * read state written by a command issued from an earlier render.
 */
export interface AssessmentSessionState {
  activeAssessmentCancellationPromise: Promise<void> | null;
  activeHomeChatStartPromise: Promise<HomeChatStartResult> | null;
  activeHomeChatWorkspaceOwnership: AssessmentWorkspaceOwnership | null;
  readonly assessmentRunCancellationPromises: Map<string, Promise<void>>;
  latestCourseConfirmationToken: symbol | null;
  latestHomeChatRequestToken: symbol | null;
  readonly openProjectAttempts: Map<number, PendingWorkspaceOpen>;
  pendingAssessmentInterviewRun: PendingAssessmentInterviewRun | null;
  pendingCancelledDraftCleanup: PendingCancelledDraftCleanup | null;
  readonly workspaceOwnershipByOpenProjectRequestId: Map<number, Set<AssessmentWorkspaceOwnership>>;
}

export const createAssessmentSessionState = (): AssessmentSessionState => ({
  activeAssessmentCancellationPromise: null,
  activeHomeChatStartPromise: null,
  activeHomeChatWorkspaceOwnership: null,
  assessmentRunCancellationPromises: new Map(),
  latestCourseConfirmationToken: null,
  latestHomeChatRequestToken: null,
  openProjectAttempts: new Map(),
  pendingAssessmentInterviewRun: null,
  pendingCancelledDraftCleanup: null,
  workspaceOwnershipByOpenProjectRequestId: new Map(),
});
