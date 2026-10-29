import {
  toWorkflowErrorDiagnostic,
  type WorkflowErrorDiagnostic,
} from './workflowErrorDiagnostics.js';

export const DEFAULT_WORKFLOW_LEASE_MS = 60_000;
export const DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS = 20_000;

export type WorkflowOperationRole = 'forward' | 'undo';

const encodeIdempotencyComponent = (value: string): string => `${value.length}:${value}`;

export const workflowOperationIdempotencyKey = (
  role: WorkflowOperationRole,
  runId: string,
  nodeInstanceId: string
): string =>
  `workflow:${role}:run:${encodeIdempotencyComponent(runId)}:node:${encodeIdempotencyComponent(nodeInstanceId)}`;

export type WorkflowHeartbeatFailure = {
  status: 'heartbeat-failed';
  diagnostic: WorkflowErrorDiagnostic;
};

export type WorkflowAttemptInterruption = 'cancelled' | 'lost' | WorkflowHeartbeatFailure | null;

export interface WorkflowAttemptMonitor {
  interruption(): WorkflowAttemptInterruption;
  stop(): Promise<WorkflowAttemptInterruption>;
}

export type AbortableOperationResult<Result> =
  | { status: 'aborted' }
  | { error: unknown; status: 'failed' }
  | { status: 'succeeded'; value: Result };

const assertRunnerTimings = (leaseMs: number, heartbeatIntervalMs: number): void => {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error('Workflow lease must be a positive integer.');
  }
  if (
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs < 1 ||
    heartbeatIntervalMs >= leaseMs
  ) {
    throw new Error('Workflow heartbeat interval must be a positive integer below the lease.');
  }
};

/** Classifies both initial and scheduled checks without retaining database messages or content. */
export const checkWorkflowHeartbeat = async <
  Result extends { status: 'cancelled' | 'lost' | 'renewed' },
>(
  heartbeat: () => Promise<Result>
): Promise<Result | WorkflowHeartbeatFailure> => {
  try {
    return await heartbeat();
  } catch (error) {
    return {
      status: 'heartbeat-failed',
      diagnostic: toWorkflowErrorDiagnostic(error, { includeContent: false }),
    };
  }
};

export const startWorkflowAttemptMonitor = (input: {
  controller: AbortController;
  heartbeat: () => Promise<{ status: 'cancelled' | 'lost' | 'renewed' }>;
  heartbeatIntervalMs: number;
  interruptionError: (interruption: 'cancelled' | 'lost') => unknown;
  leaseMs: number;
}): WorkflowAttemptMonitor => {
  assertRunnerTimings(input.leaseMs, input.heartbeatIntervalMs);
  let currentInterruption: WorkflowAttemptInterruption = null;
  let heartbeat: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const interrupt = (status: 'cancelled' | 'lost'): void => {
    currentInterruption ??= status;
    input.controller.abort(input.interruptionError(status));
  };
  const schedule = (): void => {
    if (stopped || currentInterruption) return;
    timer = setTimeout(() => {
      heartbeat = checkWorkflowHeartbeat(input.heartbeat)
        .then(result => {
          if (result.status === 'heartbeat-failed') {
            currentInterruption ??= result;
            input.controller.abort(
              new Error('The workflow heartbeat check failed.', { cause: result.diagnostic })
            );
          } else if (result.status !== 'renewed') {
            interrupt(result.status);
          }
        })
        .finally(() => {
          heartbeat = null;
          schedule();
        });
    }, input.heartbeatIntervalMs);
  };
  schedule();

  return {
    interruption: () => currentInterruption,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await heartbeat;
      return currentInterruption;
    },
  };
};

/** The operation is observed after an abort so a late rejection cannot become unhandled. */
export const raceOperationWithAbort = async <Result>(
  operation: () => Promise<Result>,
  signal: AbortSignal
): Promise<AbortableOperationResult<Result>> => {
  const settled = Promise.resolve()
    .then(operation)
    .then(
      (value): AbortableOperationResult<Result> => ({ status: 'succeeded', value }),
      (error): AbortableOperationResult<Result> => ({ error, status: 'failed' })
    );
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<AbortableOperationResult<Result>>(resolve => {
    onAbort = () => resolve({ status: 'aborted' });
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const result = await Promise.race([settled, aborted]);
  if (onAbort) signal.removeEventListener('abort', onAbort);
  return result;
};
