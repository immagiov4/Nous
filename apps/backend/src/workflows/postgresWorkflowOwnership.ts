import type postgres from 'postgres';

import type { WorkflowStepClaim } from './types.js';
import { WorkflowCancellationRequestedError, WorkflowLeaseLostError } from './workflowErrors.js';

interface OwnedNodeRow {
  lease_valid: boolean | null;
}

interface RunCancellationRow {
  cancellation_requested: boolean;
}

interface CheckpointNodeRow {
  attempt_status: string | null;
  fencing_token: string;
  lease_valid: boolean | null;
  node_status: string;
  worker_id: string | null;
}

/** Locks in node -> run order, shared by failure and checkpoint transactions. */
export const lockOwnedWorkflowClaim = async (
  sql: postgres.TransactionSql,
  claim: WorkflowStepClaim
): Promise<void> => {
  const nodeRows = await sql<OwnedNodeRow[]>`
    select lease_expires_at > clock_timestamp() as lease_valid
    from public.workflow_node_runs
    where run_id = ${claim.runId}
      and node_instance_id = ${claim.nodeInstanceId}
      and status = 'running'
      and worker_id = ${claim.workerId}
      and fencing_token = ${claim.fencingToken}
    for update
  `;
  if (!nodeRows[0]?.lease_valid) throw new WorkflowLeaseLostError();

  const runRows = await sql<RunCancellationRow[]>`
    select cancellation_requested
    from public.workflow_runs
    where id = ${claim.runId}
    for update
  `;
  if (!runRows[0]) throw new WorkflowLeaseLostError();
  if (runRows[0].cancellation_requested) throw new WorkflowCancellationRequestedError();
};

export const lockWorkflowCheckpointClaim = async (
  sql: postgres.TransactionSql,
  claim: WorkflowStepClaim
): Promise<'already-checkpointed' | 'owned'> => {
  const nodeRows = await sql<CheckpointNodeRow[]>`
    select
      node.status as node_status,
      node.worker_id,
      node.fencing_token::text,
      node.lease_expires_at > clock_timestamp() as lease_valid,
      attempt.status as attempt_status
    from public.workflow_node_runs node
    left join public.workflow_node_attempts attempt
      on attempt.run_id = node.run_id
     and attempt.node_instance_id = node.node_instance_id
     and attempt.attempt_number = ${claim.attemptNumber}
     and attempt.fencing_token = ${claim.fencingToken}
    where node.run_id = ${claim.runId}
      and node.node_instance_id = ${claim.nodeInstanceId}
    for update of node
  `;
  const node = nodeRows[0];
  if (
    node?.node_status === 'completed' &&
    node.attempt_status === 'completed' &&
    node.fencing_token === claim.fencingToken
  ) {
    return 'already-checkpointed';
  }
  if (
    node?.node_status !== 'running' ||
    node.worker_id !== claim.workerId ||
    node.fencing_token !== claim.fencingToken ||
    !node.lease_valid ||
    node.attempt_status !== 'running'
  ) {
    throw new WorkflowLeaseLostError();
  }

  const runRows = await sql<RunCancellationRow[]>`
    select cancellation_requested
    from public.workflow_runs
    where id = ${claim.runId}
    for update
  `;
  if (!runRows[0]) throw new WorkflowLeaseLostError();
  if (runRows[0].cancellation_requested) throw new WorkflowCancellationRequestedError();
  return 'owned';
};
