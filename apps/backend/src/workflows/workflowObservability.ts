import { createHash } from 'node:crypto';

import type { MaterializedWorkflowEvent } from './materialization.js';
import { getCorrelationId } from './requestObservability.js';
import type {
  JsonValue,
  StepFailure,
  WorkflowDefinitionDeploymentDecision,
  WorkflowRun,
} from './types.js';
import {
  readWorkflowErrorDiagnostic,
  readWorkflowModelDiagnostic,
  type WorkflowErrorDiagnostic,
  type WorkflowModelDiagnostic,
} from './workflowErrorDiagnostics.js';

type WorkflowLogLevel = 'error' | 'info' | 'warn';

export interface WorkflowTransientEvent {
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly runId: string;
  readonly schemaVersion: number;
  readonly workflowId: string;
}

export type WorkflowTransientEventPublisher = (event: WorkflowTransientEvent) => undefined;

const freezeJsonValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJsonValue));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeJsonValue(child)]))
    );
  }
  return value;
};

// Transient events are intentionally process-local and lossy; durable delivery uses the outbox.
const transientEventListeners = new Set<WorkflowTransientEventPublisher>();

export const publishWorkflowTransientEvent: WorkflowTransientEventPublisher = event => {
  for (const listener of transientEventListeners) {
    try {
      listener(event);
    } catch {
      // A broken observer must not prevent later observers from receiving the event.
    }
  }
  return undefined;
};

export const subscribeToWorkflowTransientEvents = (
  listener: WorkflowTransientEventPublisher
): (() => void) => {
  transientEventListeners.add(listener);
  return () => transientEventListeners.delete(listener);
};

/** Delivers lossy observational events after their authoritative transaction has committed. */
export const publishWorkflowTransientEvents = (
  publisher: WorkflowTransientEventPublisher | undefined,
  identity: { runId: string; workflowId: string },
  events: readonly MaterializedWorkflowEvent[]
): void => {
  if (!publisher) return;
  for (const event of events) {
    try {
      publisher(
        Object.freeze({
          eventType: event.eventType,
          payload: freezeJsonValue(event.payload as JsonValue),
          runId: identity.runId,
          schemaVersion: event.schemaVersion,
          workflowId: identity.workflowId,
        })
      );
    } catch {
      // Transient observers are intentionally unable to change durable workflow state.
    }
  }
};

export type WorkflowRuntimeLoop =
  | 'asset-cleanup'
  | 'cancellation-reconciliation'
  | 'notification'
  | 'step'
  | 'step-recovery'
  | 'undo'
  | 'undo-recovery'
  | 'wait-expiry';

export const WORKFLOW_RUNTIME_LOOP_FAILURE_CODE = 'workflow_runtime_loop_failed' as const;

interface WorkflowRunLogEvent {
  readonly action:
    | 'cancellation-already-requested'
    | 'cancellation-requested'
    | 'cancellation-terminal'
    | 'created'
    | 'deduplicated'
    | 'definition-unavailable'
    | 'reconciled';
  readonly cleanupStatus?: WorkflowRun['cleanupStatus'];
  readonly correlationId?: string;
  readonly event: 'workflow.run';
  readonly failureCode?: string;
  readonly failureDiagnostic?: WorkflowErrorDiagnostic;
  readonly failureKind?: StepFailure['kind'];
  readonly level: WorkflowLogLevel;
  readonly modelContext?: WorkflowModelDiagnostic;
  readonly runId: string;
  readonly runStatus: WorkflowRun['status'];
  readonly workflowId?: string;
}

type WorkflowAttemptOperation = 'step' | 'undo';

interface WorkflowAttemptLogEvent {
  readonly action:
    | 'cancelled'
    | 'checkpoint-replayed'
    | 'checkpointed'
    | 'claimed'
    | 'completed'
    | 'failed'
    | 'lease-lost'
    | 'recovered'
    | 'retry-scheduled';
  readonly attemptNumber: number;
  readonly availableAt?: string;
  readonly cleanupStatus?: WorkflowRun['cleanupStatus'];
  readonly correlationId?: string;
  readonly event: 'workflow.attempt';
  readonly failureCode?: string;
  readonly failureKind?: StepFailure['kind'];
  readonly fencingToken: string;
  readonly level: WorkflowLogLevel;
  readonly nodeDefinitionId?: string;
  readonly nodeInstanceIdDigest: string;
  readonly operation: WorkflowAttemptOperation;
  readonly outcome?: 'cancelled' | 'completed' | 'continued' | 'failed' | 'retrying' | 'running';
  readonly retryDelayMs?: number;
  readonly runId: string;
  readonly workerIdDigest: string;
  readonly workflowId?: string;
}

interface WorkflowWaitLogEvent {
  readonly action: 'cancelled' | 'created' | 'expired' | 'signal-consumed' | 'signal-replayed';
  readonly correlationId?: string;
  readonly event: 'workflow.wait';
  readonly failureCode?: string;
  readonly level: WorkflowLogLevel;
  readonly nodeInstanceIdDigest: string;
  readonly runId: string;
  readonly signalType?: string;
  readonly waitId: string;
}

interface WorkflowNotificationLogEvent {
  readonly action:
    | 'claimed'
    | 'dead-lettered'
    | 'delivered'
    | 'lease-lost'
    | 'requeued'
    | 'retry-scheduled';
  readonly actorIdDigest?: string;
  readonly attemptNumber: number;
  readonly correlationId?: string;
  readonly event: 'workflow.notification';
  readonly eventType: string;
  readonly failureCode?: string;
  readonly failureKind?: StepFailure['kind'];
  readonly fencingToken: string;
  readonly level: WorkflowLogLevel;
  readonly notificationId: string;
  readonly retryDelayMs?: number;
  readonly runId: string;
  readonly schemaVersion: number;
  readonly sequence: string;
  readonly workerIdDigest?: string;
}

interface WorkflowRuntimeLogEvent {
  readonly action: 'loop-failed';
  readonly event: 'workflow.runtime';
  readonly failureCode: typeof WORKFLOW_RUNTIME_LOOP_FAILURE_CODE;
  readonly level: 'error';
  readonly loop: WorkflowRuntimeLoop;
}

interface WorkflowDefinitionLogEvent {
  readonly action: WorkflowDefinitionDeploymentDecision;
  readonly definitionHash: string;
  readonly definitionHashVersion: number;
  readonly event: 'workflow.definition';
  readonly level: WorkflowLogLevel;
  readonly supportedDefinitionCount: number;
  readonly workflowId: string;
}

export type LifecycleOperation =
  | 'http_request'
  | 'ai_generation'
  | 'workflow_start'
  | 'workflow_poll'
  | 'workflow_cancellation'
  | 'persistence'
  | 'navigation';

interface LifecycleLogEvent {
  readonly action: 'started' | 'completed' | 'failed' | 'cancelled' | 'disconnected';
  readonly correlationId: string;
  readonly event: 'lifecycle';
  readonly failureDiagnostic?: WorkflowErrorDiagnostic;
  readonly failureCode?: string;
  readonly level: WorkflowLogLevel;
  readonly method?: string;
  readonly operation: LifecycleOperation;
  readonly path?: string;
  readonly provider?: string;
  readonly runId?: string;
  readonly statusCode?: number;
  readonly workflowId?: string;
}

export type WorkflowLogEvent =
  | WorkflowAttemptLogEvent
  | WorkflowDefinitionLogEvent
  | WorkflowNotificationLogEvent
  | WorkflowRunLogEvent
  | WorkflowRuntimeLogEvent
  | WorkflowWaitLogEvent
  | LifecycleLogEvent;

export interface WorkflowLogger {
  log(event: WorkflowLogEvent): void;
}

interface WorkflowAttemptLogIdentity {
  readonly attemptNumber: number;
  readonly correlationId?: string;
  readonly fencingToken: string;
  readonly nodeDefinitionId?: string;
  readonly nodeInstanceId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly workflowId?: string;
}

interface WorkflowNotificationLogIdentity {
  readonly attemptNumber: number;
  readonly correlationId?: string;
  readonly eventType: string;
  readonly fencingToken: string;
  readonly id: string;
  readonly runId: string;
  readonly schemaVersion: number;
  readonly sequence: string;
  readonly workerId?: string;
}

type WorkflowRunLogSource =
  | {
      readonly action: 'created' | 'deduplicated';
      readonly correlationId?: string;
      readonly entity: 'run';
      readonly run: WorkflowRun;
    }
  | {
      readonly action:
        | 'cancellation-already-requested'
        | 'cancellation-requested'
        | 'cancellation-terminal'
        | 'definition-unavailable'
        | 'reconciled';
      readonly cleanupStatus?: WorkflowRun['cleanupStatus'];
      readonly correlationId?: string;
      readonly entity: 'run';
      readonly failure?: StepFailure;
      readonly runId: string;
      readonly runStatus: WorkflowRun['status'];
      readonly workflowId?: string;
    };

interface WorkflowAttemptLogSource {
  readonly action: WorkflowAttemptLogEvent['action'];
  readonly availableAt?: string;
  readonly claim: WorkflowAttemptLogIdentity;
  readonly cleanupStatus?: WorkflowRun['cleanupStatus'];
  readonly entity: 'attempt';
  readonly failure?: StepFailure;
  readonly operation: WorkflowAttemptOperation;
  readonly outcome?: NonNullable<WorkflowAttemptLogEvent['outcome']>;
  readonly retryDelayMs?: number;
}

interface WorkflowWaitLogSource {
  readonly action: WorkflowWaitLogEvent['action'];
  readonly correlationId?: string;
  readonly entity: 'wait';
  readonly failureCode?: string;
  readonly nodeInstanceId: string;
  readonly runId: string;
  readonly signalType?: string;
  readonly waitId: string;
}

interface WorkflowNotificationLogSource {
  readonly actorId?: string;
  readonly action: WorkflowNotificationLogEvent['action'];
  readonly claim: WorkflowNotificationLogIdentity;
  readonly entity: 'notification';
  readonly failure?: StepFailure;
  readonly retryDelayMs?: number;
}

interface WorkflowRuntimeLogSource {
  readonly action: 'loop-failed';
  readonly entity: 'runtime';
  readonly loop: WorkflowRuntimeLoop;
}

interface WorkflowDefinitionLogSource {
  readonly action: WorkflowDefinitionDeploymentDecision;
  readonly boundary: {
    readonly definitionHash: string;
    readonly definitionHashVersion: number;
    readonly workflowId: string;
  };
  readonly entity: 'definition';
  readonly supportedDefinitionCount: number;
}

export type WorkflowLogSource =
  | WorkflowAttemptLogSource
  | WorkflowDefinitionLogSource
  | WorkflowNotificationLogSource
  | WorkflowRunLogSource
  | WorkflowRuntimeLogSource
  | WorkflowWaitLogSource
  | LifecycleLogSource;

interface WorkflowConsole {
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

const digestIdentifier = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

const failureFields = (
  failure: StepFailure | undefined
): { failureCode?: string; failureKind?: StepFailure['kind'] } =>
  failure ? { failureCode: failure.code, failureKind: failure.kind } : {};

const RUN_LEVEL_BY_ACTION = {
  'cancellation-already-requested': 'info',
  'cancellation-requested': 'warn',
  'cancellation-terminal': 'info',
  created: 'info',
  deduplicated: 'info',
  'definition-unavailable': 'error',
  reconciled: 'warn',
} as const satisfies Record<WorkflowRunLogEvent['action'], WorkflowLogLevel>;

const ATTEMPT_LEVEL_BY_ACTION = {
  cancelled: 'warn',
  'checkpoint-replayed': 'info',
  checkpointed: 'info',
  claimed: 'info',
  completed: 'info',
  failed: 'error',
  'lease-lost': 'error',
  recovered: 'warn',
  'retry-scheduled': 'warn',
} as const satisfies Record<WorkflowAttemptLogEvent['action'], WorkflowLogLevel>;

const WAIT_LEVEL_BY_ACTION = {
  cancelled: 'warn',
  created: 'info',
  expired: 'warn',
  'signal-consumed': 'info',
  'signal-replayed': 'info',
} as const satisfies Record<WorkflowWaitLogEvent['action'], WorkflowLogLevel>;

const NOTIFICATION_LEVEL_BY_ACTION = {
  claimed: 'info',
  'dead-lettered': 'error',
  delivered: 'info',
  'lease-lost': 'error',
  requeued: 'warn',
  'retry-scheduled': 'warn',
} as const satisfies Record<WorkflowNotificationLogEvent['action'], WorkflowLogLevel>;

const DEFINITION_LEVEL_BY_ACTION = {
  conflict: 'error',
  initialize: 'info',
  promote: 'info',
  stale: 'warn',
  unchanged: 'info',
} as const satisfies Record<WorkflowDefinitionDeploymentDecision, WorkflowLogLevel>;

const attemptFailureFields = (
  failure: StepFailure | undefined
): {
  failureCode?: string;
  failureDiagnostic?: WorkflowErrorDiagnostic;
  failureKind?: StepFailure['kind'];
  modelContext?: WorkflowModelDiagnostic;
} => {
  if (!failure) return {};
  const diagnostic = readWorkflowErrorDiagnostic(failure.details?.diagnostic);
  const model = readWorkflowModelDiagnostic(failure.details?.model);
  return {
    failureCode: failure.code,
    ...(diagnostic ? { failureDiagnostic: diagnostic } : {}),
    failureKind: failure.kind,
    ...(model ? { modelContext: model } : {}),
  };
};

const attemptLevel = (
  action: WorkflowAttemptLogEvent['action'],
  outcome?: WorkflowAttemptLogEvent['outcome']
): WorkflowLogLevel => (outcome === 'failed' ? 'error' : ATTEMPT_LEVEL_BY_ACTION[action]);

const projectRunLogEvent = (source: WorkflowRunLogSource): WorkflowRunLogEvent => {
  if ('run' in source) {
    const currentCorrelationId = getCorrelationId() ?? source.correlationId;
    const correlationId =
      source.action === 'deduplicated'
        ? (currentCorrelationId ?? source.run.correlationId)
        : (source.run.correlationId ?? currentCorrelationId);
    return {
      action: source.action,
      ...(correlationId ? { correlationId } : {}),
      cleanupStatus: source.run.cleanupStatus,
      event: 'workflow.run',
      level: RUN_LEVEL_BY_ACTION[source.action],
      runId: source.run.id,
      runStatus: source.run.status,
      workflowId: source.run.workflowId,
    };
  }
  return {
    action: source.action,
    ...(source.cleanupStatus ? { cleanupStatus: source.cleanupStatus } : {}),
    event: 'workflow.run',
    ...((source.correlationId ?? getCorrelationId())
      ? { correlationId: source.correlationId ?? getCorrelationId() }
      : {}),
    ...failureFields(source.failure),
    level: RUN_LEVEL_BY_ACTION[source.action],
    runId: source.runId,
    runStatus: source.runStatus,
    ...(source.workflowId ? { workflowId: source.workflowId } : {}),
  };
};

const projectAttemptLogEvent = (source: WorkflowAttemptLogSource): WorkflowAttemptLogEvent => ({
  action: source.action,
  attemptNumber: source.claim.attemptNumber,
  ...(source.availableAt ? { availableAt: source.availableAt } : {}),
  ...(source.cleanupStatus ? { cleanupStatus: source.cleanupStatus } : {}),
  event: 'workflow.attempt',
  ...((source.claim.correlationId ?? getCorrelationId())
    ? { correlationId: source.claim.correlationId ?? getCorrelationId() }
    : {}),
  ...attemptFailureFields(source.failure),
  fencingToken: source.claim.fencingToken,
  level: attemptLevel(source.action, source.outcome),
  ...(source.claim.nodeDefinitionId ? { nodeDefinitionId: source.claim.nodeDefinitionId } : {}),
  nodeInstanceIdDigest: digestIdentifier(source.claim.nodeInstanceId),
  operation: source.operation,
  ...(source.outcome ? { outcome: source.outcome } : {}),
  ...(source.retryDelayMs === undefined ? {} : { retryDelayMs: source.retryDelayMs }),
  runId: source.claim.runId,
  workerIdDigest: digestIdentifier(source.claim.workerId),
  ...(source.claim.workflowId ? { workflowId: source.claim.workflowId } : {}),
});

export interface LifecycleLogSource {
  readonly action: LifecycleLogEvent['action'];
  readonly correlationId?: string;
  readonly entity: 'lifecycle';
  readonly failure?: StepFailure;
  readonly method?: string;
  readonly operation: LifecycleOperation;
  readonly path?: string;
  readonly provider?: string;
  readonly runId?: string;
  readonly statusCode?: number;
  readonly workflowId?: string;
}

const LIFECYCLE_LEVEL_BY_ACTION = {
  cancelled: 'warn',
  completed: 'info',
  disconnected: 'warn',
  failed: 'error',
  started: 'info',
} as const satisfies Record<LifecycleLogEvent['action'], WorkflowLogLevel>;

const projectLifecycleLogEvent = (source: LifecycleLogSource): LifecycleLogEvent => {
  const failureDiagnostic = source.failure
    ? readWorkflowErrorDiagnostic(source.failure.details?.diagnostic)
    : undefined;
  return {
    action: source.action,
    correlationId: source.correlationId ?? getCorrelationId() ?? 'unknown',
    event: 'lifecycle',
    ...(failureDiagnostic ? { failureDiagnostic } : {}),
    ...(source.failure?.code ? { failureCode: source.failure.code } : {}),
    level: LIFECYCLE_LEVEL_BY_ACTION[source.action],
    ...(source.method ? { method: source.method } : {}),
    operation: source.operation,
    ...(source.path ? { path: source.path } : {}),
    ...(source.provider ? { provider: source.provider } : {}),
    ...(source.runId ? { runId: source.runId } : {}),
    ...(source.statusCode === undefined ? {} : { statusCode: source.statusCode }),
    ...(source.workflowId ? { workflowId: source.workflowId } : {}),
  };
};

const projectWaitLogEvent = (source: WorkflowWaitLogSource): WorkflowWaitLogEvent => ({
  action: source.action,
  ...((source.correlationId ?? getCorrelationId())
    ? { correlationId: source.correlationId ?? getCorrelationId() }
    : {}),
  event: 'workflow.wait',
  ...(source.failureCode ? { failureCode: source.failureCode } : {}),
  level: WAIT_LEVEL_BY_ACTION[source.action],
  nodeInstanceIdDigest: digestIdentifier(source.nodeInstanceId),
  runId: source.runId,
  ...(source.signalType ? { signalType: source.signalType } : {}),
  waitId: source.waitId,
});

const projectNotificationLogEvent = (
  source: WorkflowNotificationLogSource
): WorkflowNotificationLogEvent => ({
  action: source.action,
  ...(source.actorId ? { actorIdDigest: digestIdentifier(source.actorId) } : {}),
  attemptNumber: source.claim.attemptNumber,
  ...((source.claim.correlationId ?? getCorrelationId())
    ? { correlationId: source.claim.correlationId ?? getCorrelationId() }
    : {}),
  event: 'workflow.notification',
  eventType: source.claim.eventType,
  ...failureFields(source.failure),
  fencingToken: source.claim.fencingToken,
  level: NOTIFICATION_LEVEL_BY_ACTION[source.action],
  notificationId: source.claim.id,
  ...(source.retryDelayMs === undefined ? {} : { retryDelayMs: source.retryDelayMs }),
  runId: source.claim.runId,
  schemaVersion: source.claim.schemaVersion,
  sequence: source.claim.sequence,
  ...(source.claim.workerId ? { workerIdDigest: digestIdentifier(source.claim.workerId) } : {}),
});

const projectRuntimeLogEvent = (source: WorkflowRuntimeLogSource): WorkflowRuntimeLogEvent => ({
  action: source.action,
  event: 'workflow.runtime',
  failureCode: WORKFLOW_RUNTIME_LOOP_FAILURE_CODE,
  level: 'error',
  loop: source.loop,
});

const projectDefinitionLogEvent = (
  source: WorkflowDefinitionLogSource
): WorkflowDefinitionLogEvent => ({
  action: source.action,
  definitionHash: source.boundary.definitionHash,
  definitionHashVersion: source.boundary.definitionHashVersion,
  event: 'workflow.definition',
  level: DEFINITION_LEVEL_BY_ACTION[source.action],
  supportedDefinitionCount: source.supportedDefinitionCount,
  workflowId: source.boundary.workflowId,
});

/** Projects authoritative runtime outcomes into a content-free structured event. */
export const projectWorkflowLogEvent = (source: WorkflowLogSource): WorkflowLogEvent => {
  switch (source.entity) {
    case 'run':
      return projectRunLogEvent(source);
    case 'attempt':
      return projectAttemptLogEvent(source);
    case 'definition':
      return projectDefinitionLogEvent(source);
    case 'wait':
      return projectWaitLogEvent(source);
    case 'notification':
      return projectNotificationLogEvent(source);
    case 'runtime':
      return projectRuntimeLogEvent(source);
    case 'lifecycle':
      return projectLifecycleLogEvent(source);
  }
};

export class ConsoleWorkflowLogger implements WorkflowLogger {
  constructor(private readonly output: WorkflowConsole = console) {}

  log(event: WorkflowLogEvent): void {
    this.output[event.level](JSON.stringify(event));
  }
}

export const consoleWorkflowLogger: WorkflowLogger = new ConsoleWorkflowLogger();

/** Observability is best-effort and cannot roll back or fail authoritative workflow work. */
export const emitWorkflowLog = (logger: WorkflowLogger, source: WorkflowLogSource): void => {
  try {
    logger.log(Object.freeze(projectWorkflowLogEvent(source)));
  } catch {
    // The durable database state remains the source of truth if logging is unavailable.
  }
};
