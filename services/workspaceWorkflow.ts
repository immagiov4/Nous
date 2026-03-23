export const WORKSPACE_WORKFLOW_IDS = [
  'openProject',
  'attachSource',
  'importProject',
  'assessment',
  'generatePlan',
  'loadSection',
  'contextQuestion',
  'createLesson',
  'completeSection',
] as const;

export type WorkspaceWorkflowId = (typeof WORKSPACE_WORKFLOW_IDS)[number];
export type AsyncWorkflowStatus = 'idle' | 'pending' | 'succeeded' | 'failed';

export interface WorkflowEntry {
  status: AsyncWorkflowStatus;
  message?: string;
  error?: string;
  requestId: number;
}

export type WorkspaceWorkflowState = Record<WorkspaceWorkflowId, WorkflowEntry>;

export const createIdleWorkflowEntry = (): WorkflowEntry => ({
  status: 'idle',
  requestId: 0,
});

export const createWorkspaceWorkflowState = (): WorkspaceWorkflowState =>
  Object.fromEntries(
    WORKSPACE_WORKFLOW_IDS.map(workflowId => [workflowId, createIdleWorkflowEntry()])
  ) as WorkspaceWorkflowState;

export const selectIsBlocking = (workflowState: WorkspaceWorkflowState): boolean =>
  workflowState.openProject.status === 'pending' ||
  workflowState.attachSource.status === 'pending' ||
  workflowState.importProject.status === 'pending' ||
  workflowState.assessment.status === 'pending' ||
  workflowState.generatePlan.status === 'pending' ||
  workflowState.loadSection.status === 'pending' ||
  workflowState.completeSection.status === 'pending';

export const selectBlockingMessage = (
  workflowState: WorkspaceWorkflowState
): string | undefined => {
  const prioritizedWorkflowIds: WorkspaceWorkflowId[] = [
    'generatePlan',
    'loadSection',
    'assessment',
    'openProject',
    'attachSource',
    'importProject',
    'completeSection',
  ];

  for (const workflowId of prioritizedWorkflowIds) {
    const workflow = workflowState[workflowId];
    if (workflow.status === 'pending' && workflow.message) {
      return workflow.message;
    }
  }

  return undefined;
};

export const selectIsContextBusy = (workflowState: WorkspaceWorkflowState): boolean =>
  workflowState.contextQuestion.status === 'pending' ||
  workflowState.createLesson.status === 'pending';
