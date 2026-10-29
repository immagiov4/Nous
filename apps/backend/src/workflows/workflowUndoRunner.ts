import { snapshotImmutableJson } from './jsonSnapshot.js';
import type {
  WorkflowUndoClaim,
  WorkflowUndoCompletionResult,
  WorkflowUndoHeartbeatResult,
} from './postgresWorkflowUndoStore.js';
import { WorkflowUndoLeaseLostError } from './postgresWorkflowUndoStore.js';
import { toStepFailure } from './retryPolicy.js';
import type { StepFailure, StepUndoContext, WorkflowNode } from './types.js';
import {
  executeWorkflowCheckpointWithRetry,
  isTransientPostgresCheckpointError,
} from './workflowCheckpointRetry.js';
import { toWorkflowErrorDiagnostic } from './workflowErrorDiagnostics.js';
import { emitWorkflowHeartbeatFailure } from './workflowObservability.js';
import {
  checkWorkflowHeartbeat,
  DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKFLOW_LEASE_MS,
  raceOperationWithAbort,
  startWorkflowAttemptMonitor,
  type WorkflowAttemptMonitor,
  type WorkflowHeartbeatFailure,
  workflowOperationIdempotencyKey,
} from './workflowStepAttempt.js';
import {
  resolveClaimedWorkflowDefinition,
  resolveClaimedWorkflowStepPolicy,
  type WorkflowClaimResolutionFailure,
  type WorkflowDefinitionResolver,
} from './workflowStepResolution.js';

export interface WorkflowUndoRunnerStore {
  complete(claim: WorkflowUndoClaim): Promise<WorkflowUndoCompletionResult>;
  heartbeat(input: {
    claim: WorkflowUndoClaim;
    leaseMs: number;
  }): Promise<WorkflowUndoHeartbeatResult>;
  recordFailure(input: { claim: WorkflowUndoClaim; failure: StepFailure }): Promise<unknown>;
}

export interface WorkflowUndoRunnerInput<Services> {
  claim: WorkflowUndoClaim;
  heartbeatIntervalMs?: number;
  leaseMs?: number;
  registry: WorkflowDefinitionResolver;
  services: Services;
  store: WorkflowUndoRunnerStore;
}

export type WorkflowUndoRunnerResult =
  | WorkflowUndoCompletionResult
  | WorkflowHeartbeatFailure
  | { failure: StepFailure; status: 'failure-recorded' }
  | { status: 'lease-lost' };

interface ResolvedWorkflowUndo {
  config: Readonly<Record<string, unknown>>;
  input: unknown;
  output: unknown;
  step: Extract<WorkflowNode, { kind: 'step' }>;
}

type WorkflowUndoResolution =
  | { failure: StepFailure; resolved: false }
  | { resolved: true; value: ResolvedWorkflowUndo };

const permanentFailure = (code: string, message: string): StepFailure => ({
  code,
  kind: 'permanent',
  message,
});

const UNDO_CLAIM_FAILURES: Record<
  WorkflowClaimResolutionFailure['reason'],
  readonly [code: string, message: string]
> = {
  'config-incompatible': [
    'workflow_undo_config_incompatible',
    'The workflow undo configuration does not match its durable schema.',
  ],
  'definition-incompatible': [
    'workflow_definition_incompatible',
    'The claimed workflow definition is incompatible with this worker.',
  ],
  'definition-unavailable': [
    'workflow_definition_unavailable',
    'The workflow definition required by this cleanup is unavailable.',
  ],
  'policy-snapshot-incompatible': [
    'workflow_undo_policy_incompatible',
    'The workflow undo policy differs from the run snapshot.',
  ],
  'policy-version-incompatible': [
    'workflow_undo_policy_incompatible',
    'The workflow undo policy version is unsupported.',
  ],
};

const mapUndoClaimFailure = (
  resolution: WorkflowClaimResolutionFailure
): WorkflowUndoResolution => {
  const [code, message] = UNDO_CLAIM_FAILURES[resolution.reason];
  return {
    failure: {
      ...permanentFailure(code, message),
      ...(resolution.details && { details: resolution.details }),
    },
    resolved: false,
  };
};

const resolveWorkflowUndoClaim = (
  registry: WorkflowDefinitionResolver,
  claim: WorkflowUndoClaim
): WorkflowUndoResolution => {
  const claimedDefinition = resolveClaimedWorkflowDefinition(registry, claim);
  if (!claimedDefinition.resolved) return mapUndoClaimFailure(claimedDefinition);

  const { definition, node } = claimedDefinition.value;
  if (node?.kind !== 'step' || !node.undo) {
    return {
      failure: permanentFailure(
        'workflow_undo_definition_incompatible',
        'The claimed workflow step does not provide the required undo operation.'
      ),
      resolved: false,
    };
  }
  const claimedPolicy = resolveClaimedWorkflowStepPolicy(definition, claim);
  if (!claimedPolicy.resolved) return mapUndoClaimFailure(claimedPolicy);

  let undoInput: unknown;
  try {
    undoInput = snapshotImmutableJson(node.inputSchema.parse(claim.input));
  } catch {
    return {
      failure: permanentFailure(
        'workflow_undo_input_incompatible',
        'The workflow undo input does not match its durable schema.'
      ),
      resolved: false,
    };
  }
  try {
    return {
      resolved: true,
      value: {
        config: claimedPolicy.config,
        input: undoInput,
        output: snapshotImmutableJson(node.outputSchema.parse(claim.output)),
        step: node,
      },
    };
  } catch {
    return {
      failure: permanentFailure(
        'workflow_undo_output_incompatible',
        'The workflow undo output does not match its durable schema.'
      ),
      resolved: false,
    };
  }
};

const timeoutFailure = (cause: unknown): StepFailure => ({
  code: 'workflow_undo_timeout',
  details: { diagnostic: toWorkflowErrorDiagnostic(cause) },
  kind: 'operational',
  message: 'The workflow undo exceeded its execution timeout.',
});

const completionFailure = (error: unknown): StepFailure => ({
  code: 'workflow_undo_completion_failed',
  details: { diagnostic: toWorkflowErrorDiagnostic(error) },
  kind: 'permanent',
  message: 'The workflow undo could not be recorded as completed.',
});

const recordFailure = async (
  store: WorkflowUndoRunnerStore,
  claim: WorkflowUndoClaim,
  failure: StepFailure
): Promise<WorkflowUndoRunnerResult> => {
  try {
    await store.recordFailure({ claim, failure });
    return { failure, status: 'failure-recorded' };
  } catch (error) {
    if (error instanceof WorkflowUndoLeaseLostError) return { status: 'lease-lost' };
    throw error;
  }
};

const stopForUndoInterruption = async (
  monitor: WorkflowAttemptMonitor,
  claim: WorkflowUndoClaim,
  error?: unknown
): Promise<WorkflowUndoRunnerResult | null> => {
  const interruption = await monitor.stop();
  if (!interruption)
    return error instanceof WorkflowUndoLeaseLostError ? { status: 'lease-lost' } : null;
  if (typeof interruption === 'object') {
    emitWorkflowHeartbeatFailure(claim, 'undo', interruption.diagnostic);
    return interruption;
  }
  return { status: 'lease-lost' };
};

const checkInitialUndoHeartbeat = async (
  input: Pick<WorkflowUndoRunnerInput<unknown>, 'claim' | 'store'>,
  leaseMs: number
): Promise<WorkflowUndoRunnerResult | null> => {
  const heartbeat = await checkWorkflowHeartbeat(() =>
    input.store.heartbeat({ claim: input.claim, leaseMs })
  );
  if (heartbeat.status === 'heartbeat-failed') {
    emitWorkflowHeartbeatFailure(input.claim, 'undo', heartbeat.diagnostic);
    return heartbeat;
  }
  return heartbeat.status === 'lost' ? { status: 'lease-lost' } : null;
};

export const workflowUndoIdempotencyKey = (claim: WorkflowUndoClaim): string =>
  workflowOperationIdempotencyKey('undo', claim.runId, claim.nodeInstanceId);

export const runWorkflowUndoClaim = async <Services>(
  input: WorkflowUndoRunnerInput<Services>
): Promise<WorkflowUndoRunnerResult> => {
  const resolution = resolveWorkflowUndoClaim(input.registry, input.claim);
  if (!resolution.resolved) {
    return recordFailure(input.store, input.claim, resolution.failure);
  }

  const leaseMs = input.leaseMs ?? DEFAULT_WORKFLOW_LEASE_MS;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS;
  const initialInterruption = await checkInitialUndoHeartbeat(input, leaseMs);
  if (initialInterruption) return initialInterruption;
  const controller = new AbortController();
  const monitor = startWorkflowAttemptMonitor({
    controller,
    heartbeat: () => input.store.heartbeat({ claim: input.claim, leaseMs }),
    heartbeatIntervalMs,
    interruptionError: () => new WorkflowUndoLeaseLostError(),
    leaseMs,
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Workflow undo timed out.'));
  }, input.claim.timeoutMs);

  const { config, input: undoInput, output, step } = resolution.value;
  const undo = step.undo as unknown as (
    context: StepUndoContext<unknown, unknown, Record<string, unknown>, Services>
  ) => Promise<void>;
  const undoResult = await raceOperationWithAbort(
    () =>
      undo({
        config,
        execution: Object.freeze({
          nodeInstanceId: input.claim.nodeInstanceId,
          runId: input.claim.runId,
        }),
        idempotencyKey: workflowUndoIdempotencyKey(input.claim),
        input: undoInput,
        output,
        services: input.services,
        signal: controller.signal,
      }),
    controller.signal
  );
  clearTimeout(timeout);

  if (undoResult.status !== 'succeeded' || timedOut || monitor.interruption()) {
    const interruption = await stopForUndoInterruption(monitor, input.claim);
    if (interruption) return interruption;
    const failureCause =
      undoResult.status === 'failed' ? undoResult.error : controller.signal.reason;
    return recordFailure(
      input.store,
      input.claim,
      timedOut ? timeoutFailure(failureCause) : toStepFailure(failureCause)
    );
  }

  try {
    const result = await executeWorkflowCheckpointWithRetry(
      () => input.store.complete(input.claim),
      controller.signal
    );
    await monitor.stop();
    return result;
  } catch (error) {
    const interruption = await stopForUndoInterruption(monitor, input.claim, error);
    if (interruption) return interruption;
    if (isTransientPostgresCheckpointError(error)) {
      throw new Error('Transient undo completion retry ended without losing the lease.', {
        cause: error,
      });
    }
    return recordFailure(input.store, input.claim, completionFailure(error));
  }
};
