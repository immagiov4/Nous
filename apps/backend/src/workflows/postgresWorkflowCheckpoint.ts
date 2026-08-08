import type { Sql, TransactionSql } from 'postgres';

import { planWorkflowContinuation, planWorkflowFailure } from './continuation.js';
import type { MaterializedWorkflowEvent } from './materialization.js';
import { lockWorkflowCheckpointClaim } from './postgresWorkflowOwnership.js';
import { asPostgresJson, insertWorkflowAiUsage } from './postgresWorkflowPersistence.js';
import {
  applyWorkflowContinuationPlan,
  createStableWaitIdFactory,
  failWorkflowRun,
  loadWorkflowNodeSnapshots,
} from './postgresWorkflowPlanStore.js';
import type {
  ErasedRegisteredWorkflow,
  RegisteredWorkflow,
  StepFailure,
  WorkflowStepClaim,
  WorkflowStepPolicies,
} from './types.js';
import { WORKFLOW_STEP_POLICIES_VERSION } from './types.js';
import type { WorkflowAiUsageRecord } from './workflowAiMetering.js';
import { lockAuthorizedWorkflowDefinitions } from './workflowDefinitionReconciler.js';
import { WorkflowLeaseLostError } from './workflowErrors.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  type WorkflowLogger,
} from './workflowObservability.js';

export type WorkflowCheckpointResult =
  | { status: 'already-checkpointed' }
  | {
      status: 'checkpointed';
      transientEvents: readonly MaterializedWorkflowEvent[];
    };

export interface CheckpointWorkflowStepInput {
  aiUsage?: readonly WorkflowAiUsageRecord[];
  claim: WorkflowStepClaim;
  commit?: (transaction: TransactionSql) => Promise<void>;
  definition: ErasedRegisteredWorkflow;
  output: unknown;
}

export interface CheckpointWorkflowStepOptions {
  enforceCurrentDefinitions?: boolean;
  logger?: WorkflowLogger;
}

export interface ExpiredWorkflowStepBoundary {
  definitionHash: string;
  definitionHashVersion: number;
  fencingToken: string;
  nodeInstanceId: string;
  runId: string;
  stepPolicies: WorkflowStepPolicies;
  stepPoliciesVersion: number;
  workerId: string;
  workflowId: string;
}

const assertMatchingDefinition = (
  definition: ErasedRegisteredWorkflow,
  claim: WorkflowStepClaim
): void => {
  if (claim.stepPoliciesVersion !== WORKFLOW_STEP_POLICIES_VERSION) {
    throw new Error(`Workflow step policy version is unsupported for run ${claim.runId}.`);
  }
  if (
    definition.id !== claim.workflowId ||
    definition.definitionHash !== claim.definitionHash ||
    definition.definitionHashVersion !== claim.definitionHashVersion
  ) {
    throw new Error(`Workflow definition does not match claimed run ${claim.runId}.`);
  }
};

const updateOwnedCompletedNode = async (
  sql: TransactionSql,
  claim: WorkflowStepClaim,
  output: unknown
): Promise<void> => {
  const sequenceRows = await sql<Array<{ next_completion_sequence: string }>>`
    update public.workflow_runs
    set next_completion_sequence = next_completion_sequence + 1
    where id = ${claim.runId}
    returning next_completion_sequence::text
  `;
  const completionSequence = sequenceRows[0]?.next_completion_sequence;
  if (!completionSequence) throw new WorkflowLeaseLostError();
  const rows = await sql`
    update public.workflow_node_runs
    set status = 'completed',
        output = ${sql.json(asPostgresJson(output))},
        error = null,
        worker_id = null,
        lease_expires_at = null,
        completion_sequence = ${completionSequence},
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where run_id = ${claim.runId}
      and node_instance_id = ${claim.nodeInstanceId}
      and status = 'running'
      and worker_id = ${claim.workerId}
      and fencing_token = ${claim.fencingToken}
      and lease_expires_at > clock_timestamp()
    returning 1
  `;
  if (rows.length !== 1) throw new WorkflowLeaseLostError();
};

const updateOwnedFailedNode = async (
  sql: TransactionSql,
  claim: WorkflowStepClaim,
  failure: StepFailure
): Promise<void> => {
  const rows = await sql`
    update public.workflow_node_runs
    set status = 'failed',
        error = ${sql.json(asPostgresJson(failure))},
        worker_id = null,
        lease_expires_at = null,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where run_id = ${claim.runId}
      and node_instance_id = ${claim.nodeInstanceId}
      and status = 'running'
      and worker_id = ${claim.workerId}
      and fencing_token = ${claim.fencingToken}
      and lease_expires_at > clock_timestamp()
    returning 1
  `;
  if (rows.length !== 1) throw new WorkflowLeaseLostError();
};

const finishAttempt = async (
  sql: TransactionSql,
  claim: WorkflowStepClaim,
  status: 'completed' | 'failed',
  failure?: StepFailure
): Promise<void> => {
  const rows = await sql`
    update public.workflow_node_attempts
    set status = ${status},
        error = ${failure ? sql.json(asPostgresJson(failure)) : null},
        finished_at = clock_timestamp()
    where run_id = ${claim.runId}
      and node_instance_id = ${claim.nodeInstanceId}
      and attempt_number = ${claim.attemptNumber}
      and fencing_token = ${claim.fencingToken}
      and status = 'running'
    returning 1
  `;
  if (rows.length !== 1) throw new WorkflowLeaseLostError();
};

export const checkpointWorkflowStep = async (
  sql: Sql,
  input: CheckpointWorkflowStepInput,
  options: CheckpointWorkflowStepOptions = {}
): Promise<WorkflowCheckpointResult> => {
  assertMatchingDefinition(input.definition, input.claim);
  const checkpoint = await sql.begin(async transaction => {
    if (options.enforceCurrentDefinitions) {
      const authorized = await lockAuthorizedWorkflowDefinitions(transaction, [
        {
          definitionHash: input.claim.definitionHash,
          definitionHashVersion: input.claim.definitionHashVersion,
          workflowId: input.claim.workflowId,
        },
      ]);
      if (authorized.length !== 1) throw new WorkflowLeaseLostError();
    }
    const ownership = await lockWorkflowCheckpointClaim(transaction, input.claim);
    if (ownership === 'already-checkpointed') {
      return {
        result: { status: 'already-checkpointed' as const },
        waits: [],
      };
    }
    const nodes = await loadWorkflowNodeSnapshots(transaction, input.claim.runId);
    const plan = planWorkflowContinuation({
      completedNode: { nodeInstanceId: input.claim.nodeInstanceId, output: input.output },
      definition: input.definition as unknown as RegisteredWorkflow,
      nodes,
      stepPolicies: input.claim.stepPolicies,
      waitIdForNode: createStableWaitIdFactory(),
    });
    await input.commit?.(transaction);
    await insertWorkflowAiUsage(transaction, input.aiUsage ?? []);
    await applyWorkflowContinuationPlan(
      transaction,
      input.claim,
      plan,
      'completed',
      async update => {
        if (update.status !== 'completed') throw new Error('Expected a completed workflow step.');
        await updateOwnedCompletedNode(transaction, input.claim, update.output);
        await finishAttempt(transaction, input.claim, 'completed');
      }
    );
    return {
      result: { status: 'checkpointed' as const, transientEvents: plan.transientEvents },
      waits: plan.newWaits,
    };
  });
  const logger = options.logger ?? consoleWorkflowLogger;
  emitWorkflowLog(logger, {
    action: checkpoint.result.status === 'checkpointed' ? 'checkpointed' : 'checkpoint-replayed',
    claim: input.claim,
    entity: 'attempt',
    operation: 'step',
    outcome: 'completed',
  });
  for (const wait of checkpoint.waits) {
    emitWorkflowLog(logger, {
      action: 'created',
      entity: 'wait',
      nodeInstanceId: wait.nodeInstanceId,
      runId: input.claim.runId,
      signalType: wait.signalType,
      waitId: wait.waitId,
    });
  }
  return checkpoint.result;
};

export const failWorkflowStep = async (
  sql: TransactionSql,
  input: {
    claim: WorkflowStepClaim;
    definition: ErasedRegisteredWorkflow;
    failure: StepFailure;
  }
): Promise<readonly MaterializedWorkflowEvent[]> => {
  assertMatchingDefinition(input.definition, input.claim);
  const nodes = await loadWorkflowNodeSnapshots(sql, input.claim.runId);
  const plan = planWorkflowFailure({
    definition: input.definition as unknown as RegisteredWorkflow,
    failedNode: { failure: input.failure, nodeInstanceId: input.claim.nodeInstanceId },
    nodes,
    stepPolicies: input.claim.stepPolicies,
    waitIdForNode: createStableWaitIdFactory(),
  });
  await applyWorkflowContinuationPlan(sql, input.claim, plan, 'failed', async update => {
    if (update.status !== 'failed') throw new Error('Expected a failed workflow step.');
    await updateOwnedFailedNode(sql, input.claim, update.failure);
    await finishAttempt(sql, input.claim, 'failed', update.failure);
  });
  return plan.transientEvents;
};

export const failExpiredWorkflowStep = async (
  sql: TransactionSql,
  input: {
    boundary: ExpiredWorkflowStepBoundary;
    definition: RegisteredWorkflow;
    failure: StepFailure;
  }
): Promise<{
  runOutcome: 'completed' | 'failed' | 'running';
  transientEvents: readonly MaterializedWorkflowEvent[];
}> => {
  const { boundary } = input;
  if (boundary.stepPoliciesVersion !== WORKFLOW_STEP_POLICIES_VERSION) {
    throw new Error(`Workflow step policy version is unsupported for run ${boundary.runId}.`);
  }
  if (
    input.definition.id !== boundary.workflowId ||
    input.definition.definitionHash !== boundary.definitionHash ||
    input.definition.definitionHashVersion !== boundary.definitionHashVersion
  ) {
    throw new Error(`Workflow definition does not match expired run ${boundary.runId}.`);
  }
  const nodes = await loadWorkflowNodeSnapshots(sql, boundary.runId);
  const plan = planWorkflowFailure({
    definition: input.definition,
    failedNode: { failure: input.failure, nodeInstanceId: boundary.nodeInstanceId },
    nodes,
    stepPolicies: boundary.stepPolicies,
    waitIdForNode: createStableWaitIdFactory(),
  });
  await applyWorkflowContinuationPlan(sql, boundary, plan, 'failed', async update => {
    if (update.status !== 'failed') throw new Error('Expected a failed workflow step.');
    const rows = await sql`
      update public.workflow_node_runs
      set status = 'failed',
          error = ${sql.json(asPostgresJson(update.failure))},
          worker_id = null,
          lease_expires_at = null,
          fencing_token = fencing_token + 1,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where run_id = ${boundary.runId}
        and node_instance_id = ${boundary.nodeInstanceId}
        and status = 'running'
        and worker_id = ${boundary.workerId}
        and fencing_token = ${boundary.fencingToken}
        and lease_expires_at <= clock_timestamp()
      returning 1
    `;
    if (rows.length !== 1) throw new WorkflowLeaseLostError();
  });
  let runOutcome: 'completed' | 'failed' | 'running' = 'running';
  if (plan.terminalFailure) runOutcome = 'failed';
  else if (Object.hasOwn(plan, 'completedOutput')) runOutcome = 'completed';
  return { runOutcome, transientEvents: plan.transientEvents };
};

export const failWorkflowForMissingDefinition = async (
  sql: TransactionSql,
  input: {
    attemptNumber: number;
    failure: StepFailure;
    fencingToken: string;
    nodeInstanceId: string;
    runId: string;
    workerId: string;
  }
): Promise<void> => {
  const attemptRows = await sql`
    update public.workflow_node_attempts
    set status = 'lost',
        error = ${sql.json(asPostgresJson(input.failure))},
        finished_at = clock_timestamp()
    where run_id = ${input.runId}
      and node_instance_id = ${input.nodeInstanceId}
      and attempt_number = ${input.attemptNumber}
      and fencing_token = ${input.fencingToken}
      and worker_id = ${input.workerId}
      and status = 'running'
    returning 1
  `;
  if (attemptRows.length !== 1) throw new WorkflowLeaseLostError();
  const nodeRows = await sql`
    update public.workflow_node_runs
    set status = 'cancelled',
        error = ${sql.json(asPostgresJson(input.failure))},
        worker_id = null,
        lease_expires_at = null,
        fencing_token = fencing_token + case when status = 'running' then 1 else 0 end,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where run_id = ${input.runId}
      and node_instance_id = ${input.nodeInstanceId}
      and status = 'running'
      and worker_id = ${input.workerId}
      and fencing_token = ${input.fencingToken}
    returning 1
  `;
  if (nodeRows.length !== 1) throw new WorkflowLeaseLostError();
  await failWorkflowRun(sql, input.runId, input.failure);
  await sql`
    update public.workflow_runs
    set cleanup_status = case
      when exists (
        select 1 from public.workflow_node_runs
        where run_id = ${input.runId} and status = 'completed' and has_undo
      ) then 'failed'
      else 'not-required'
    end
    where id = ${input.runId}
  `;
};
