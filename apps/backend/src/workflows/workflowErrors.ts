export class WorkflowLeaseLostError extends Error {
  constructor() {
    super('The workflow step lease is no longer owned by this worker.');
    this.name = 'WorkflowLeaseLostError';
  }
}

export class WorkflowCancellationRequestedError extends Error {
  constructor() {
    super('The workflow was cancelled while this step was running.');
    this.name = 'WorkflowCancellationRequestedError';
  }
}

export class WorkflowOutboxLeaseLostError extends Error {
  constructor() {
    super('The durable notification lease is no longer owned by this worker.');
    this.name = 'WorkflowOutboxLeaseLostError';
  }
}

export class WorkflowRunNotFoundError extends Error {
  constructor() {
    super('The workflow run does not exist or is not accessible.');
    this.name = 'WorkflowRunNotFoundError';
  }
}

export class WorkflowRunRequestConflictError extends Error {
  readonly code = 'workflow_run_request_conflict';

  constructor() {
    super('The workflow request key was already used for a different request.');
    this.name = 'WorkflowRunRequestConflictError';
  }
}

export class WorkflowDefinitionDeploymentConflictError extends Error {
  constructor(readonly workflowId: string) {
    super(`Workflow definition deployment conflicts with the active release: ${workflowId}.`);
    this.name = 'WorkflowDefinitionDeploymentConflictError';
  }
}

export class WorkflowDefinitionRegistryDeploymentConflictError extends Error {
  constructor(readonly registryScope: string) {
    super(
      `Workflow definition registry changed without incrementing its workflow-set version: ${registryScope}.`
    );
    this.name = 'WorkflowDefinitionRegistryDeploymentConflictError';
  }
}

export class WorkflowReplicaOutdatedError extends Error {
  constructor() {
    super('This backend replica does not own the active workflow definition.');
    this.name = 'WorkflowReplicaOutdatedError';
  }
}

export type WorkflowSignalErrorCode =
  | 'workflow_signal_forbidden'
  | 'workflow_signal_request_conflict'
  | 'workflow_signal_type_mismatch'
  | 'workflow_wait_expired'
  | 'workflow_wait_obsolete'
  | 'workflow_wait_unknown';

export class WorkflowSignalError extends Error {
  constructor(
    readonly code: WorkflowSignalErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkflowSignalError';
  }
}
