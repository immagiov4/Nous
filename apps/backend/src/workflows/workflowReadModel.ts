import { snapshotImmutableJson } from './jsonSnapshot.js';
import type { JsonValue, StepFailure, WorkflowNodeKind, WorkflowRun } from './types.js';

export interface WorkflowDurableEventState {
  readonly createdAt: string;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly schemaVersion: number;
  readonly sequence: string;
}

export interface WorkflowNodeRunState {
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly definitionId: string;
  readonly error?: StepFailure;
  readonly instanceId: string;
  readonly itemKey?: string;
  readonly kind: WorkflowNodeKind;
  readonly maxAttempts: number;
  readonly parentInstanceId?: string;
  readonly status:
    | 'cancelled'
    | 'completed'
    | 'failed'
    | 'queued'
    | 'retrying'
    | 'running'
    | 'waiting';
  readonly updatedAt: string;
}

/** An event deliberately mapped for API consumers by one registered workflow vertical. */
export interface WorkflowPublishedEventState {
  readonly createdAt: string;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly schemaVersion: number;
  readonly sequence: string;
}

export interface WorkflowPublicRunState {
  readonly nodes: readonly WorkflowNodeRunState[];
  readonly publishedEvents: readonly WorkflowPublishedEventState[];
  readonly run: WorkflowRunLifecycleState;
  readonly waits: readonly WorkflowSignalWaitState[];
}

export interface WorkflowRunState {
  readonly events: readonly WorkflowDurableEventState[];
  readonly nodes: readonly WorkflowNodeRunState[];
  readonly run: WorkflowRunLifecycleState;
  readonly waits: readonly WorkflowSignalWaitState[];
}

export interface WorkflowRunLifecycleState {
  readonly cancellationRequested: boolean;
  readonly cleanupStatus: WorkflowRun['cleanupStatus'];
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly definitionHash: string;
  readonly definitionHashVersion: number;
  readonly error?: StepFailure;
  readonly id: string;
  readonly projectId?: string;
  readonly requestKey: string;
  readonly startedAt?: string;
  readonly status: WorkflowRun['status'];
  readonly updatedAt: string;
  readonly workflowId: string;
}

export interface WorkflowSignalWaitState {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly nodeInstanceId: string;
  readonly schemaVersion: number;
  readonly signalType: string;
  readonly waitId: string;
}

const compareNodeStates = (left: WorkflowNodeRunState, right: WorkflowNodeRunState): number => {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.instanceId === right.instanceId) return 0;
  return left.instanceId < right.instanceId ? -1 : 1;
};

const compareEvents = (
  left: WorkflowDurableEventState,
  right: WorkflowDurableEventState
): number => {
  const difference = BigInt(left.sequence) - BigInt(right.sequence);
  if (difference < 0n) return -1;
  if (difference > 0n) return 1;
  return 0;
};

const compareWaits = (left: WorkflowSignalWaitState, right: WorkflowSignalWaitState): number => {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.waitId === right.waitId) return 0;
  return left.waitId < right.waitId ? -1 : 1;
};

interface CreateWorkflowRunStateInput {
  readonly events: readonly WorkflowDurableEventState[];
  readonly nodes: readonly WorkflowNodeRunState[];
  readonly run: WorkflowRun;
  readonly waits: readonly WorkflowSignalWaitState[];
}

interface CreateWorkflowPublicRunStateInput {
  readonly publishedEvents: readonly WorkflowPublishedEventState[];
  readonly state: WorkflowRunState;
}

const createRunLifecycleState = (run: WorkflowRun): WorkflowRunLifecycleState => ({
  cancellationRequested: run.cancellationRequested,
  cleanupStatus: run.cleanupStatus,
  ...(run.completedAt ? { completedAt: run.completedAt } : {}),
  createdAt: run.createdAt,
  definitionHash: run.definitionHash,
  definitionHashVersion: run.definitionHashVersion,
  ...(run.error ? { error: run.error } : {}),
  id: run.id,
  ...(run.projectId ? { projectId: run.projectId } : {}),
  requestKey: run.requestKey,
  ...(run.startedAt ? { startedAt: run.startedAt } : {}),
  status: run.status,
  updatedAt: run.updatedAt,
  workflowId: run.workflowId,
});

/** Creates the stable technical lifecycle snapshot consumed by workflow-specific UI mappers. */
export const createWorkflowRunState = (input: CreateWorkflowRunStateInput): WorkflowRunState =>
  snapshotImmutableJson({
    events: [...input.events].sort(compareEvents),
    nodes: [...input.nodes].sort(compareNodeStates),
    run: createRunLifecycleState(input.run),
    waits: [...input.waits].sort(compareWaits),
  });

/** Removes internal durable events and snapshots only events explicitly projected for clients. */
export const createWorkflowPublicRunState = (
  input: CreateWorkflowPublicRunStateInput
): WorkflowPublicRunState =>
  snapshotImmutableJson({
    nodes: input.state.nodes,
    publishedEvents: [...input.publishedEvents].sort(compareEvents),
    run: input.state.run,
    waits: input.state.waits,
  });
