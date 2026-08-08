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

export type WorkflowAttemptInterruption = 'cancelled' | 'lost' | null;

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

export const startWorkflowAttemptMonitor = (input: {
  controller: AbortController;
  heartbeat: () => Promise<{ status: Exclude<WorkflowAttemptInterruption, null> | 'renewed' }>;
  heartbeatIntervalMs: number;
  interruptionError: (interruption: Exclude<WorkflowAttemptInterruption, null>) => unknown;
  leaseMs: number;
}): WorkflowAttemptMonitor => {
  assertRunnerTimings(input.leaseMs, input.heartbeatIntervalMs);
  let currentInterruption: WorkflowAttemptInterruption = null;
  let heartbeat: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const interrupt = (status: Exclude<WorkflowAttemptInterruption, null>): void => {
    currentInterruption ??= status;
    input.controller.abort(input.interruptionError(status));
  };
  const schedule = (): void => {
    if (stopped || currentInterruption) return;
    timer = setTimeout(() => {
      heartbeat = input
        .heartbeat()
        .then(result => {
          if (result.status !== 'renewed') interrupt(result.status);
        })
        .catch(() => interrupt('lost'))
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
