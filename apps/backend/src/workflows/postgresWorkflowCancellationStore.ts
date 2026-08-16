import type { Sql, TransactionSql } from 'postgres';

import { asPostgresJson, insertWorkflowAiUsage } from './postgresWorkflowPersistence.js';
import type { StepFailure, WorkflowRun, WorkflowStepClaim } from './types.js';
import type { WorkflowAiUsageRecord } from './workflowAiMetering.js';
import { WorkflowLeaseLostError, WorkflowRunNotFoundError } from './workflowErrors.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  type WorkflowLogger,
} from './workflowObservability.js';

interface CancellationRunRow {
  cancellation_requested: boolean;
  cleanup_status: WorkflowRun['cleanupStatus'];
  correlation_id: string;
  status: WorkflowRun['status'];
}

interface TerminalCandidateRow {
  id: string;
}

interface CancelledWaitRow {
  node_instance_id: string;
  signal_type: string;
  wait_id: string;
}

const CANCELLATION_FAILURE: StepFailure = {
  code: 'workflow_cancelled',
  kind: 'permanent',
  message: 'The workflow was cancelled.',
};

export type WorkflowCancellationRequestResult = {
  runStatus: WorkflowRun['status'];
  status: 'already-requested' | 'requested' | 'terminal';
};

export type WorkflowTerminalReconciliationResult = {
  cleanupStatus: WorkflowRun['cleanupStatus'];
  runId: string;
  runStatus: WorkflowRun['status'];
};

const lockOwnedRun = async (
  sql: TransactionSql,
  runId: string,
  userId: string
): Promise<CancellationRunRow> => {
  const rows = await sql<CancellationRunRow[]>`
    select status, cleanup_status, cancellation_requested, correlation_id
    from public.workflow_runs
    where id = ${runId} and user_id = ${userId}
    for update
  `;
  const run = rows[0];
  if (!run) throw new WorkflowRunNotFoundError();
  return run;
};

const materializeUndoRuns = async (sql: TransactionSql, runId: string): Promise<number> => {
  const invalid = await sql`
    select 1
    from public.workflow_node_runs
    where run_id = ${runId}
      and status = 'completed'
      and has_undo
      and completion_sequence is null
    limit 1
  `;
  if (invalid.length > 0) {
    throw new Error(`Workflow run ${runId} has an unordered undo boundary.`);
  }
  const inserted = await sql<Array<{ node_instance_id: string }>>`
    insert into public.workflow_undo_runs (
      run_id, node_instance_id, reverse_order, input, output, max_attempts, timeout_ms
    )
    select
      run_id,
      node_instance_id,
      row_number() over (order by completion_sequence desc)::integer - 1,
      input,
      output,
      max_attempts,
      timeout_ms
    from public.workflow_node_runs
    where run_id = ${runId} and status = 'completed' and has_undo
    returning node_instance_id
  `;
  return inserted.length;
};

const findTerminalCandidate = async (
  sql: TransactionSql,
  runId?: string
): Promise<TerminalCandidateRow | null> => {
  const rows = await sql<TerminalCandidateRow[]>`
    select run.id
    from public.workflow_runs run
    where (${runId ?? null}::uuid is null or run.id = ${runId ?? null}::uuid)
      and run.cancellation_requested
      and run.status in ('queued', 'running', 'waiting', 'failed', 'cancelled', 'expired')
      and not exists (
        select 1 from public.workflow_node_runs node
        where node.run_id = run.id and node.status = 'running'
      )
      and (
        run.status in ('queued', 'running', 'waiting')
        or exists (
          select 1 from public.workflow_node_runs node
          where node.run_id = run.id and node.status in ('queued', 'retrying', 'waiting')
        )
        or exists (
          select 1 from public.workflow_waits wait
          where wait.run_id = run.id and wait.status = 'waiting'
        )
        or (
          run.cleanup_status = 'pending'
          and not exists (select 1 from public.workflow_undo_runs undo where undo.run_id = run.id)
        )
      )
    order by run.updated_at, run.id
    limit 1
  `;
  return rows[0] ?? null;
};

const lockTerminalCandidateNodes = async (sql: TransactionSql, runId: string): Promise<void> => {
  await sql`
    select node_instance_id
    from public.workflow_node_runs
    where run_id = ${runId}
    order by node_instance_id
    for update
  `;
};

const lockTerminalCandidateUndoRuns = async (
  sql: TransactionSql,
  runId: string
): Promise<number> => {
  const rows = await sql<Array<{ node_instance_id: string }>>`
    select node_instance_id
    from public.workflow_undo_runs
    where run_id = ${runId}
    order by reverse_order, node_instance_id
    for update
  `;
  return rows.length;
};

const lockTerminalCandidateRun = async (
  sql: TransactionSql,
  runId: string
): Promise<CancellationRunRow | null> => {
  const rows = await sql<CancellationRunRow[]>`
    select status, cleanup_status, cancellation_requested, correlation_id
    from public.workflow_runs
    where id = ${runId}
    for update
  `;
  return rows[0] ?? null;
};

const cleanupStatusAfterReconciliation = (
  current: WorkflowRun['cleanupStatus'],
  undoCount: number
): WorkflowRun['cleanupStatus'] => {
  if (current === 'completed' || current === 'failed') return current;
  if (undoCount === 0) return 'not-required';
  return current === 'running' ? 'running' : 'pending';
};

const cancellationLogAction = (
  status: WorkflowCancellationRequestResult['status']
): 'cancellation-already-requested' | 'cancellation-requested' | 'cancellation-terminal' => {
  if (status === 'requested') return 'cancellation-requested';
  if (status === 'already-requested') return 'cancellation-already-requested';
  return 'cancellation-terminal';
};

export class PostgresWorkflowCancellationStore {
  constructor(
    private readonly sql: Sql,
    private readonly logger: WorkflowLogger = consoleWorkflowLogger
  ) {}

  async request(input: {
    runId: string;
    userId: string;
  }): Promise<WorkflowCancellationRequestResult> {
    const outcome = await this.sql.begin(async sql => {
      const run = await lockOwnedRun(sql, input.runId, input.userId);
      if (['cancelled', 'completed', 'expired', 'failed'].includes(run.status)) {
        return {
          cleanupStatus: run.cleanup_status,
          result: { runStatus: run.status, status: 'terminal' as const },
        };
      }
      if (run.cancellation_requested) {
        return {
          cleanupStatus: run.cleanup_status,
          result: { runStatus: run.status, status: 'already-requested' as const },
        };
      }
      await sql`
        update public.workflow_runs
        set cancellation_requested = true, updated_at = clock_timestamp(), version = version + 1
        where id = ${input.runId}
      `;
      await sql`select pg_notify('workflow_cleanup', ${input.runId})`;
      return {
        cleanupStatus: run.cleanup_status,
        result: { runStatus: run.status, status: 'requested' as const },
      };
    });
    emitWorkflowLog(this.logger, {
      action: cancellationLogAction(outcome.result.status),
      cleanupStatus: outcome.cleanupStatus,
      entity: 'run',
      runId: input.runId,
      runStatus: outcome.result.runStatus,
    });
    return outcome.result;
  }

  async releaseClaim(
    claim: WorkflowStepClaim,
    aiUsage: readonly WorkflowAiUsageRecord[] = []
  ): Promise<void> {
    await this.sql.begin(async sql => {
      const nodes = await sql`
        select 1
        from public.workflow_node_runs
        where run_id = ${claim.runId}
          and node_instance_id = ${claim.nodeInstanceId}
          and status = 'running'
          and worker_id = ${claim.workerId}
          and fencing_token = ${claim.fencingToken}
          and lease_expires_at > clock_timestamp()
        for update
      `;
      if (nodes.length !== 1) throw new WorkflowLeaseLostError();
      const runs = await sql<Array<{ cancellation_requested: boolean }>>`
        select cancellation_requested
        from public.workflow_runs
        where id = ${claim.runId}
        for update
      `;
      if (!runs[0]?.cancellation_requested) {
        throw new Error(`Workflow run ${claim.runId} has not been cancelled.`);
      }
      await insertWorkflowAiUsage(sql, aiUsage);
      const attempts = await sql`
        update public.workflow_node_attempts
        set status = 'cancelled',
            error = ${sql.json(asPostgresJson(CANCELLATION_FAILURE))},
            finished_at = clock_timestamp()
        where run_id = ${claim.runId}
          and node_instance_id = ${claim.nodeInstanceId}
          and attempt_number = ${claim.attemptNumber}
          and fencing_token = ${claim.fencingToken}
          and status = 'running'
        returning 1
      `;
      if (attempts.length !== 1) throw new WorkflowLeaseLostError();
      const released = await sql`
        update public.workflow_node_runs
        set status = 'cancelled',
            error = ${sql.json(asPostgresJson(CANCELLATION_FAILURE))},
            worker_id = null,
            lease_expires_at = null,
            fencing_token = fencing_token + 1,
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where run_id = ${claim.runId}
          and node_instance_id = ${claim.nodeInstanceId}
          and status = 'running'
          and worker_id = ${claim.workerId}
          and fencing_token = ${claim.fencingToken}
        returning 1
      `;
      if (released.length !== 1) throw new WorkflowLeaseLostError();
      await sql`select pg_notify('workflow_cleanup', ${claim.runId})`;
    });
    emitWorkflowLog(this.logger, {
      action: 'cancelled',
      claim,
      entity: 'attempt',
      failure: CANCELLATION_FAILURE,
      operation: 'step',
      outcome: 'cancelled',
    });
  }

  async reconcileNext(): Promise<WorkflowTerminalReconciliationResult | null> {
    const reconciliation = await this.sql.begin(async sql => {
      const candidate = await findTerminalCandidate(sql);
      if (!candidate) return null;

      // Existing undo rows are locked before the run, matching undo workers' undo -> run order.
      await lockTerminalCandidateNodes(sql, candidate.id);
      const existingUndoCount = await lockTerminalCandidateUndoRuns(sql, candidate.id);
      const run = await lockTerminalCandidateRun(sql, candidate.id);
      if (!run || !(await findTerminalCandidate(sql, candidate.id))) return null;

      await sql`
        update public.workflow_node_runs
        set status = 'cancelled',
            error = coalesce(error, ${sql.json(asPostgresJson(CANCELLATION_FAILURE))}),
            completed_at = coalesce(completed_at, clock_timestamp()),
            updated_at = clock_timestamp()
        where run_id = ${candidate.id} and status in ('queued', 'retrying', 'waiting')
      `;
      const cancelledWaits = await sql<CancelledWaitRow[]>`
        update public.workflow_waits
        set status = 'cancelled', finished_at = clock_timestamp()
        where run_id = ${candidate.id} and status = 'waiting'
        returning id::text as wait_id, node_instance_id, signal_type
      `;
      // Node locks serialize this store's sole undo insertion path, so a zero count stays stable.
      const undoCount =
        existingUndoCount > 0 || ['completed', 'failed'].includes(run.cleanup_status)
          ? existingUndoCount
          : await materializeUndoRuns(sql, candidate.id);
      const cleanupStatus = cleanupStatusAfterReconciliation(run.cleanup_status, undoCount);
      const runStatus: WorkflowRun['status'] = ['queued', 'running', 'waiting'].includes(run.status)
        ? 'cancelled'
        : run.status;
      await sql`
        update public.workflow_runs
        set status = ${runStatus},
            cleanup_status = ${cleanupStatus},
            error = case
              when status in ('queued', 'running', 'waiting')
                then ${sql.json(asPostgresJson(CANCELLATION_FAILURE))}
              else error
            end,
            completed_at = coalesce(completed_at, clock_timestamp()),
            updated_at = clock_timestamp(),
            version = version + 1
        where id = ${candidate.id}
      `;
      if (cleanupStatus === 'pending') {
        await sql`select pg_notify('workflow_undo_ready', ${candidate.id})`;
      }
      return {
        cancelledWaits,
        correlationId: run.correlation_id,
        result: { cleanupStatus, runId: candidate.id, runStatus },
      };
    });
    if (!reconciliation) return null;
    emitWorkflowLog(this.logger, {
      action: 'reconciled',
      cleanupStatus: reconciliation.result.cleanupStatus,
      correlationId: reconciliation.correlationId,
      entity: 'run',
      ...(reconciliation.result.runStatus === 'cancelled' ? { failure: CANCELLATION_FAILURE } : {}),
      runId: reconciliation.result.runId,
      runStatus: reconciliation.result.runStatus,
    });
    for (const wait of reconciliation.cancelledWaits) {
      emitWorkflowLog(this.logger, {
        action: 'cancelled',
        entity: 'wait',
        failureCode: CANCELLATION_FAILURE.code,
        nodeInstanceId: wait.node_instance_id,
        runId: reconciliation.result.runId,
        signalType: wait.signal_type,
        waitId: wait.wait_id,
      });
    }
    return reconciliation.result;
  }
}
