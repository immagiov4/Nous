import type { TransactionSql } from 'postgres';

import { snapshotImmutableJson } from './jsonSnapshot.js';
import type { WorkflowCheckpointResult } from './postgresWorkflowCheckpoint.js';
import type {
  WorkflowHeartbeatResult,
  WorkflowStepFailureResult,
} from './postgresWorkflowStepStore.js';
import { toStepFailure } from './retryPolicy.js';
import type {
  ErasedRegisteredWorkflow,
  StepCommitContext,
  StepExecutionContext,
  StepFailure,
  WorkflowStepClaim,
} from './types.js';
import {
  runWithWorkflowAttemptMetering,
  type WorkflowAiUsageRecord,
} from './workflowAiMetering.js';
import { executeWorkflowCheckpointWithRetry } from './workflowCheckpointRetry.js';
import { WorkflowCancellationRequestedError, WorkflowLeaseLostError } from './workflowErrors.js';
import {
  type AbortableOperationResult,
  DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKFLOW_LEASE_MS,
  raceOperationWithAbort,
  startWorkflowAttemptMonitor,
  type WorkflowAttemptInterruption,
  type WorkflowAttemptMonitor,
} from './workflowStepAttempt.js';
import {
  type ResolvedWorkflowStep,
  resolveWorkflowStepClaim,
  type WorkflowDefinitionResolver,
  type WorkflowStepResolution,
  workflowStepIdempotencyKey,
} from './workflowStepResolution.js';

export {
  DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKFLOW_LEASE_MS,
} from './workflowStepAttempt.js';

export interface WorkflowStepRunnerStore {
  checkpointStep(input: {
    claim: WorkflowStepClaim;
    commit?: (transaction: TransactionSql) => Promise<void>;
    definition: ErasedRegisteredWorkflow;
    output: unknown;
  }): Promise<WorkflowCheckpointResult>;
  cancellation: {
    releaseClaim(claim: WorkflowStepClaim): Promise<void>;
  };
  recordAiUsage(usage: WorkflowAiUsageRecord): Promise<void>;
  steps: {
    heartbeat(input: {
      claim: WorkflowStepClaim;
      leaseMs: number;
    }): Promise<WorkflowHeartbeatResult>;
    recordDefinitionUnavailable(input: {
      claim: WorkflowStepClaim;
      failure: StepFailure;
    }): Promise<unknown>;
    recordFailure(input: {
      claim: WorkflowStepClaim;
      definition: ErasedRegisteredWorkflow;
      failure: StepFailure;
    }): Promise<WorkflowStepFailureResult>;
  };
}

export interface WorkflowStepRunnerInput<Services> {
  claim: WorkflowStepClaim;
  heartbeatIntervalMs?: number;
  leaseMs?: number;
  registry: WorkflowDefinitionResolver;
  services: Services;
  store: WorkflowStepRunnerStore;
}

export type WorkflowStepRunnerResult =
  | WorkflowCheckpointResult
  | {
      failure: StepFailure;
      status: 'failure-recorded';
      transientEvents: readonly import('./materialization.js').MaterializedWorkflowEvent[];
    }
  | { status: 'cancelled' | 'lease-lost' };

const timeoutFailure = (): StepFailure => ({
  code: 'workflow_step_timeout',
  kind: 'operational',
  message: 'The workflow step exceeded its execution timeout.',
});

const invalidOutputFailure = (): StepFailure => ({
  code: 'workflow_step_output_invalid',
  feedback: 'Return an output that matches the declared schema.',
  kind: 'corrective',
  message: 'The workflow step returned an invalid output.',
});

const checkpointFailure = (): StepFailure => ({
  code: 'workflow_step_checkpoint_failed',
  kind: 'permanent',
  message: 'The workflow step output could not be committed.',
});

async function finishInterruptedClaim(
  store: WorkflowStepRunnerStore,
  claim: WorkflowStepClaim,
  interruption: Exclude<WorkflowAttemptInterruption, null>
): Promise<WorkflowStepRunnerResult> {
  if (interruption === 'lost') return { status: 'lease-lost' };
  try {
    await store.cancellation.releaseClaim(claim);
    return { status: 'cancelled' };
  } catch (error) {
    if (error instanceof WorkflowLeaseLostError) return { status: 'lease-lost' };
    throw error;
  }
}

const recordFailure = async (
  store: WorkflowStepRunnerStore,
  claim: WorkflowStepClaim,
  definition: ErasedRegisteredWorkflow,
  failure: StepFailure
): Promise<WorkflowStepRunnerResult> => {
  try {
    const result = await store.steps.recordFailure({ claim, definition, failure });
    return {
      failure,
      status: 'failure-recorded',
      transientEvents: result.status === 'failed' ? result.transientEvents : [],
    };
  } catch (error) {
    if (error instanceof WorkflowLeaseLostError) return { status: 'lease-lost' };
    if (error instanceof WorkflowCancellationRequestedError) {
      return finishInterruptedClaim(store, claim, 'cancelled');
    }
    throw error;
  }
};

const recordUnavailableDefinition = async (
  store: WorkflowStepRunnerStore,
  claim: WorkflowStepClaim,
  failure: StepFailure
): Promise<WorkflowStepRunnerResult> => {
  try {
    await store.steps.recordDefinitionUnavailable({ claim, failure });
    return { failure, status: 'failure-recorded', transientEvents: [] };
  } catch (error) {
    if (error instanceof WorkflowLeaseLostError) return { status: 'lease-lost' };
    if (error instanceof WorkflowCancellationRequestedError) {
      return finishInterruptedClaim(store, claim, 'cancelled');
    }
    throw error;
  }
};

const stopForInterruption = async (
  store: WorkflowStepRunnerStore,
  claim: WorkflowStepClaim,
  monitor: WorkflowAttemptMonitor
): Promise<WorkflowStepRunnerResult | null> => {
  const interruption = await monitor.stop();
  return interruption ? finishInterruptedClaim(store, claim, interruption) : null;
};

const recordResolutionFailure = (
  store: WorkflowStepRunnerStore,
  claim: WorkflowStepClaim,
  resolution: Extract<WorkflowStepResolution, { resolved: false }>
): Promise<WorkflowStepRunnerResult> =>
  resolution.registeredDefinition
    ? recordFailure(store, claim, resolution.registeredDefinition, resolution.failure)
    : recordUnavailableDefinition(store, claim, resolution.failure);

interface WorkflowStepAttemptResult {
  controller: AbortController;
  monitor: WorkflowAttemptMonitor;
  runResult: AbortableOperationResult<unknown>;
  timedOut: boolean;
}

const executeStepCallback = async <Services>(input: {
  claim: WorkflowStepClaim;
  heartbeatIntervalMs: number;
  leaseMs: number;
  resolved: ResolvedWorkflowStep;
  services: Services;
  store: WorkflowStepRunnerStore;
}): Promise<WorkflowStepAttemptResult> => {
  const controller = new AbortController();
  const monitor = startWorkflowAttemptMonitor({
    controller,
    heartbeat: () => input.store.steps.heartbeat({ claim: input.claim, leaseMs: input.leaseMs }),
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    interruptionError: interruption =>
      interruption === 'cancelled'
        ? new WorkflowCancellationRequestedError()
        : new WorkflowLeaseLostError(),
    leaseMs: input.leaseMs,
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Workflow step timed out.'));
  }, input.claim.timeoutMs);
  const run = input.resolved.step.run as unknown as (
    context: StepExecutionContext<unknown, Record<string, unknown>, Services>
  ) => Promise<unknown>;
  try {
    const runResult = await raceOperationWithAbort(
      () =>
        runWithWorkflowAttemptMetering(
          {
            attemptNumber: input.claim.attemptNumber,
            nodeInstanceId: input.claim.nodeInstanceId,
            record: usage =>
              executeWorkflowCheckpointWithRetry(
                () => input.store.recordAiUsage(usage),
                controller.signal
              ),
            runId: input.claim.runId,
          },
          () =>
            run({
              attemptNumber: input.claim.attemptNumber,
              config: input.resolved.config,
              execution: Object.freeze({
                nodeInstanceId: input.claim.nodeInstanceId,
                runId: input.claim.runId,
              }),
              idempotencyKey: workflowStepIdempotencyKey(input.claim),
              input: input.resolved.input,
              ...(input.claim.previousAttemptFailure
                ? { previousAttemptFailure: input.claim.previousAttemptFailure }
                : {}),
              retryFeedback: input.claim.retryFeedback,
              services: input.services,
              signal: controller.signal,
            })
        ),
      controller.signal
    );
    return { controller, monitor, runResult, timedOut };
  } finally {
    clearTimeout(timeout);
  }
};

const finishFailedStepAttempt = async (input: {
  attempt: WorkflowStepAttemptResult;
  claim: WorkflowStepClaim;
  definition: ErasedRegisteredWorkflow;
  store: WorkflowStepRunnerStore;
}): Promise<WorkflowStepRunnerResult> => {
  const interrupted = await stopForInterruption(input.store, input.claim, input.attempt.monitor);
  if (interrupted) return interrupted;
  const failureCause =
    input.attempt.runResult.status === 'failed'
      ? input.attempt.runResult.error
      : input.attempt.controller.signal.reason;
  return recordFailure(
    input.store,
    input.claim,
    input.definition,
    input.attempt.timedOut ? timeoutFailure() : toStepFailure(failureCause)
  );
};

type ParsedStepOutput = { output: unknown; valid: true } | { valid: false };

const parseStepOutput = (resolved: ResolvedWorkflowStep, value: unknown): ParsedStepOutput => {
  try {
    return { output: snapshotImmutableJson(resolved.step.outputSchema.parse(value)), valid: true };
  } catch {
    return { valid: false };
  }
};

const checkpointStepOutput = async <Services>(input: {
  attempt: WorkflowStepAttemptResult;
  claim: WorkflowStepClaim;
  output: unknown;
  resolved: ResolvedWorkflowStep;
  services: Services;
  store: WorkflowStepRunnerStore;
}): Promise<WorkflowStepRunnerResult> => {
  const commit = input.resolved.step.commit as
    | ((
        context: StepCommitContext<unknown, unknown, Record<string, unknown>, Services>
      ) => Promise<void>)
    | undefined;
  const checkpoint = () =>
    input.store.checkpointStep({
      claim: input.claim,
      ...(commit
        ? {
            commit: (transaction: TransactionSql) =>
              commit({
                config: input.resolved.config,
                execution: Object.freeze({
                  nodeInstanceId: input.claim.nodeInstanceId,
                  runId: input.claim.runId,
                }),
                input: input.resolved.input,
                output: input.output,
                services: input.services,
                transaction,
              }),
          }
        : {}),
      definition: input.resolved.definition,
      output: input.output,
    });

  try {
    const result = await executeWorkflowCheckpointWithRetry(
      checkpoint,
      input.attempt.controller.signal
    );
    await input.attempt.monitor.stop();
    return result;
  } catch (error) {
    const interrupted = await stopForInterruption(input.store, input.claim, input.attempt.monitor);
    if (interrupted) return interrupted;
    if (error instanceof WorkflowCancellationRequestedError) {
      return finishInterruptedClaim(input.store, input.claim, 'cancelled');
    }
    if (error instanceof WorkflowLeaseLostError) return { status: 'lease-lost' };
    return recordFailure(input.store, input.claim, input.resolved.definition, checkpointFailure());
  }
};

export const runWorkflowStepClaim = async <Services>(
  input: WorkflowStepRunnerInput<Services>
): Promise<WorkflowStepRunnerResult> => {
  const resolution = resolveWorkflowStepClaim(input.registry, input.claim);
  if (!resolution.resolved) return recordResolutionFailure(input.store, input.claim, resolution);

  const leaseMs = input.leaseMs ?? DEFAULT_WORKFLOW_LEASE_MS;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS;
  const initialHeartbeat = await input.store.steps.heartbeat({ claim: input.claim, leaseMs });
  if (initialHeartbeat.status !== 'renewed') {
    return finishInterruptedClaim(input.store, input.claim, initialHeartbeat.status);
  }
  const attempt = await executeStepCallback({
    claim: input.claim,
    heartbeatIntervalMs,
    leaseMs,
    resolved: resolution.value,
    services: input.services,
    store: input.store,
  });
  if (
    attempt.runResult.status !== 'succeeded' ||
    attempt.timedOut ||
    attempt.monitor.interruption()
  ) {
    return finishFailedStepAttempt({
      attempt,
      claim: input.claim,
      definition: resolution.value.definition,
      store: input.store,
    });
  }

  const parsedOutput = parseStepOutput(resolution.value, attempt.runResult.value);
  if (!parsedOutput.valid) {
    const interrupted = await stopForInterruption(input.store, input.claim, attempt.monitor);
    if (interrupted) return interrupted;
    return recordFailure(
      input.store,
      input.claim,
      resolution.value.definition,
      invalidOutputFailure()
    );
  }

  return checkpointStepOutput({
    attempt,
    claim: input.claim,
    output: parsedOutput.output,
    resolved: resolution.value,
    services: input.services,
    store: input.store,
  });
};
