const WORKSPACE_WORKFLOW_IDS = [
  'openProject',
  'attachSource',
  'importProject',
  'assessment',
  'generatePlan',
  'generateExercise',
  'evaluateExercise',
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
  reasoning?: string;
  error?: string;
  requestId: number;
}

export type WorkspaceWorkflowState = Record<WorkspaceWorkflowId, WorkflowEntry>;

const createIdleWorkflowEntry = (): WorkflowEntry => ({
  status: 'idle',
  requestId: 0,
});

export const createWorkspaceWorkflowState = (): WorkspaceWorkflowState =>
  Object.fromEntries(
    WORKSPACE_WORKFLOW_IDS.map(workflowId => [workflowId, createIdleWorkflowEntry()])
  ) as WorkspaceWorkflowState;

export const invalidateWorkspaceWorkflows = (
  workflowState: WorkspaceWorkflowState,
  workflowIds: WorkspaceWorkflowId[]
): WorkspaceWorkflowState => {
  if (workflowIds.length === 0) {
    return workflowState;
  }

  const workflowIdSet = new Set(workflowIds);

  return Object.fromEntries(
    WORKSPACE_WORKFLOW_IDS.map(workflowId => {
      if (!workflowIdSet.has(workflowId)) {
        return [workflowId, workflowState[workflowId]];
      }

      return [
        workflowId,
        {
          status: 'idle' as const,
          requestId: workflowState[workflowId].requestId + 1,
        },
      ];
    })
  ) as WorkspaceWorkflowState;
};

export const selectIsBlocking = (workflowState: WorkspaceWorkflowState): boolean =>
  workflowState.openProject.status === 'pending' ||
  workflowState.attachSource.status === 'pending' ||
  workflowState.importProject.status === 'pending' ||
  workflowState.assessment.status === 'pending' ||
  workflowState.generatePlan.status === 'pending' ||
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

export const selectBlockingReasoning = (
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
    if (workflow.status === 'pending' && workflow.reasoning) {
      return workflow.reasoning;
    }
  }

  return undefined;
};

export const selectIsContextBusy = (workflowState: WorkspaceWorkflowState): boolean =>
  workflowState.contextQuestion.status === 'pending' ||
  workflowState.createLesson.status === 'pending';
