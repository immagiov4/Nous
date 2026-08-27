import type { TransactionSql } from 'postgres';
import * as z from 'zod';

import {
  firstSanitizedZodIssue,
  formatValidationPath,
  type SanitizedZodIssue,
} from '../utils/zodDiagnostics.js';
import { snapshotImmutableJson } from './jsonSnapshot.js';
import type { WorkflowCheckpointResult } from './postgresWorkflowCheckpoint.js';
import type { RecordWorkflowProviderResultInput } from './postgresWorkflowProviderEffectStore.js';
import type {
  WorkflowHeartbeatResult,
  WorkflowStepFailureResult,
} from './postgresWorkflowStepStore.js';
import { toStepFailure } from './retryPolicy.js';
import type {
  ErasedRegisteredWorkflow,
  JsonValue,
  StepCommitContext,
  StepExecutionContext,
  StepFailure,
  WorkflowProviderEffectExecutor,
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
  providerEffects: {
    getResult(
      input: Omit<RecordWorkflowProviderResultInput, 'output'>
    ): Promise<JsonValue | undefined>;
    recordResult(input: RecordWorkflowProviderResultInput): Promise<JsonValue>;
  };
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
      aiUsage?: readonly WorkflowAiUsageRecord[];
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

const invalidOutputFailure = (issue?: SanitizedZodIssue): StepFailure => ({
  code: 'workflow_step_output_invalid',
  ...(issue
    ? {
        details: {
          validationIssue: { code: issue.code, path: [...issue.path] },
        },
        feedback: `Return an output that matches the declared schema. Correct ${formatValidationPath(issue.path)} (${issue.code}).`,
      }
    : { feedback: 'Return an output that matches the declared schema.' }),
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

const recordFailure = async (input: {
  aiUsage?: readonly WorkflowAiUsageRecord[];
  claim: WorkflowStepClaim;
  definition: ErasedRegisteredWorkflow;
  failure: StepFailure;
  store: WorkflowStepRunnerStore;
}): Promise<WorkflowStepRunnerResult> => {
  try {
    const result = await input.store.steps.recordFailure({
      ...(input.aiUsage?.length ? { aiUsage: input.aiUsage } : {}),
      claim: input.claim,
      definition: input.definition,
      failure: input.failure,
    });
    return {
      failure: input.failure,
      status: 'failure-recorded',
      transientEvents: result.status === 'failed' ? result.transientEvents : [],
    };
  } catch (error) {
    if (error instanceof WorkflowLeaseLostError) return { status: 'lease-lost' };
    if (error instanceof WorkflowCancellationRequestedError) {
      return finishInterruptedClaim(input.store, input.claim, 'cancelled');
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
    ? recordFailure({
        claim,
        definition: resolution.registeredDefinition,
        failure: resolution.failure,
        store,
      })
    : recordUnavailableDefinition(store, claim, resolution.failure);

interface WorkflowStepAttemptResult {
  controller: AbortController;
  monitor: WorkflowAttemptMonitor;
  pendingAiUsage: WorkflowAiUsageRecord[];
  runResult: AbortableOperationResult<unknown>;
  timedOut: boolean;
}

type ParsedStepOutput =
  | { output: JsonValue; valid: true }
  | { issue?: SanitizedZodIssue; valid: false };

const parseStepOutput = (resolved: ResolvedWorkflowStep, value: unknown): ParsedStepOutput => {
  try {
    const output = snapshotImmutableJson(resolved.step.outputSchema.parse(value)) as JsonValue;
    return { output, valid: true };
  } catch (error) {
    return error instanceof z.ZodError
      ? { issue: firstSanitizedZodIssue(error), valid: false }
      : { valid: false };
  }
};

const persistProviderResult = async (input: {
  claim: WorkflowStepClaim;
  leaseMs: number;
  pendingAiUsage: WorkflowAiUsageRecord[];
  resolved: ResolvedWorkflowStep;
  store: WorkflowStepRunnerStore;
  value: unknown;
}): Promise<unknown> => {
  if (input.resolved.step.externalEffect !== 'provider') return input.value;
  const parsed = parseStepOutput(input.resolved, input.value);
  if (!parsed.valid) return input.value;
  const aiUsage = [...input.pendingAiUsage];
  const authoritative = await executeWorkflowCheckpointWithRetry(
    () =>
      input.store.providerEffects.recordResult({
        aiUsage,
        idempotencyKey: workflowStepIdempotencyKey(input.claim),
        nodeInstanceId: input.claim.nodeInstanceId,
        output: parsed.output,
        runId: input.claim.runId,
      }),
    AbortSignal.timeout(input.leaseMs)
  );
  input.pendingAiUsage.splice(0, aiUsage.length);
  return authoritative;
};

const readProviderResult = async (input: {
  claim: WorkflowStepClaim;
  idempotencyKey?: string;
  signal: AbortSignal;
  store: WorkflowStepRunnerStore;
}): Promise<JsonValue | undefined> => {
  return executeWorkflowCheckpointWithRetry(
    () =>
      input.store.providerEffects.getResult({
        idempotencyKey: input.idempotencyKey ?? workflowStepIdempotencyKey(input.claim),
        nodeInstanceId: input.claim.nodeInstanceId,
        runId: input.claim.runId,
      }),
    input.signal
  );
};

const createProviderEffectExecutor = (input: {
  claim: WorkflowStepClaim;
  leaseMs: number;
  pendingAiUsage: WorkflowAiUsageRecord[];
  signal: AbortSignal;
  store: WorkflowStepRunnerStore;
}): WorkflowProviderEffectExecutor => ({
  async run({ key, operation, outputSchema }) {
    const idempotencyKey = `${workflowStepIdempotencyKey(input.claim)}:provider:${key}`;
    const persisted = await readProviderResult({ ...input, idempotencyKey });
    if (persisted !== undefined) return outputSchema.parse(persisted);
    const usageStart = input.pendingAiUsage.length;
    const output = snapshotImmutableJson(outputSchema.parse(await operation())) as JsonValue;
    const aiUsage = input.pendingAiUsage.slice(usageStart);
    const authoritative = await executeWorkflowCheckpointWithRetry(
      () =>
        input.store.providerEffects.recordResult({
          aiUsage,
          idempotencyKey,
          nodeInstanceId: input.claim.nodeInstanceId,
          output,
          runId: input.claim.runId,
        }),
      AbortSignal.timeout(input.leaseMs)
    );
    input.pendingAiUsage.splice(usageStart, aiUsage.length);
    return outputSchema.parse(authoritative);
  },
});

const flushPendingAiUsage = async (input: {
  leaseMs: number;
  pendingAiUsage: WorkflowAiUsageRecord[];
  store: WorkflowStepRunnerStore;
}): Promise<void> => {
  let persistedUsageCount = 0;
  try {
    for (const usage of input.pendingAiUsage) {
      await executeWorkflowCheckpointWithRetry(
        () => input.store.recordAiUsage(usage),
        AbortSignal.timeout(input.leaseMs)
      );
      persistedUsageCount += 1;
    }
  } finally {
    input.pendingAiUsage.splice(0, persistedUsageCount);
  }
};

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
  const pendingAiUsage: WorkflowAiUsageRecord[] = [];
  try {
    if (input.resolved.step.externalEffect === 'provider') {
      const persistedResult = await raceOperationWithAbort(
        () =>
          readProviderResult({
            claim: input.claim,
            signal: controller.signal,
            store: input.store,
          }),
        controller.signal
      );
      if (persistedResult.status !== 'succeeded' || persistedResult.value !== undefined) {
        return { controller, monitor, pendingAiUsage, runResult: persistedResult, timedOut };
      }
    }
    const runResult = await raceOperationWithAbort(
      () =>
        runWithWorkflowAttemptMetering(
          {
            attemptNumber: input.claim.attemptNumber,
            nodeInstanceId: input.claim.nodeInstanceId,
            record: async usage => {
              pendingAiUsage.push({
                ...usage,
                ...(controller.signal.aborted ? { reportedAfterInterruption: true as const } : {}),
              });
            },
            runId: input.claim.runId,
          },
          async () => {
            const value = await run({
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
              ...(input.claim.retryFeedbackSourceAttemptNumber === undefined
                ? {}
                : {
                    retryFeedbackSourceAttemptNumber: input.claim.retryFeedbackSourceAttemptNumber,
                  }),
              ...(input.resolved.step.externalEffect === 'provider-with-postprocessing'
                ? {
                    providerEffect: createProviderEffectExecutor({
                      claim: input.claim,
                      leaseMs: input.leaseMs,
                      pendingAiUsage,
                      signal: controller.signal,
                      store: input.store,
                    }),
                  }
                : {}),
              services: input.services,
              signal: controller.signal,
            });
            return persistProviderResult({
              claim: input.claim,
              leaseMs: input.leaseMs,
              pendingAiUsage,
              resolved: input.resolved,
              store: input.store,
              value,
            });
          }
        ).then(
          async value => {
            await flushPendingAiUsage({
              leaseMs: input.leaseMs,
              pendingAiUsage,
              store: input.store,
            });
            return value;
          },
          async error => {
            await flushPendingAiUsage({
              leaseMs: input.leaseMs,
              pendingAiUsage,
              store: input.store,
            });
            throw error;
          }
        ),
      controller.signal
    );
    return { controller, monitor, pendingAiUsage, runResult, timedOut };
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
  return recordFailure({
    aiUsage: input.attempt.pendingAiUsage,
    claim: input.claim,
    definition: input.definition,
    failure: input.attempt.timedOut ? timeoutFailure() : toStepFailure(failureCause),
    store: input.store,
  });
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
    return recordFailure({
      claim: input.claim,
      definition: input.resolved.definition,
      failure: checkpointFailure(),
      store: input.store,
    });
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
    return recordFailure({
      claim: input.claim,
      definition: resolution.value.definition,
      failure: invalidOutputFailure(parsedOutput.issue),
      store: input.store,
    });
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
