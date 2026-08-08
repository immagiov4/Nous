import type { Sql } from 'postgres';

import { asPostgresJson } from './postgresWorkflowPersistence.js';
import type { StepFailure } from './types.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  type WorkflowLogger,
} from './workflowObservability.js';

interface ExpiredWaitCandidateRow {
  node_instance_id: string;
  run_id: string;
  signal_type: string;
  wait_id: string;
}

const WAIT_EXPIRED_FAILURE: StepFailure = {
  code: 'workflow_wait_expired',
  kind: 'permanent',
  message: 'The workflow wait expired before a signal was received.',
};

export interface ExpiredWorkflowWaitResult {
  nodeInstanceId: string;
  runId: string;
  waitId: string;
}

export class PostgresWorkflowWaitStore {
  constructor(
    private readonly sql: Sql,
    private readonly logger: WorkflowLogger = consoleWorkflowLogger
  ) {}

  async expireNext(): Promise<ExpiredWorkflowWaitResult | null> {
    const expired = await this.sql.begin(async sql => {
      const candidates = await sql<ExpiredWaitCandidateRow[]>`
        select
          wait.id::text as wait_id,
          wait.run_id,
          wait.node_instance_id,
          wait.signal_type
        from public.workflow_waits wait
        join public.workflow_node_runs node
          on node.run_id = wait.run_id and node.node_instance_id = wait.node_instance_id
        join public.workflow_runs run on run.id = wait.run_id
        where wait.status = 'waiting'
          and wait.expires_at <= clock_timestamp()
          and node.status = 'waiting'
          and run.status in ('queued', 'running', 'waiting')
          and not run.cancellation_requested
        order by wait.expires_at, wait.run_id, wait.node_instance_id
        for update of node skip locked
        limit 1
      `;
      const candidate = candidates[0];
      if (!candidate) return null;

      const runRows = await sql`
        select 1
        from public.workflow_runs
        where id = ${candidate.run_id}
          and status in ('queued', 'running', 'waiting')
          and not cancellation_requested
        for update
      `;
      if (runRows.length !== 1) return null;
      const waitRows = await sql`
        select 1
        from public.workflow_waits
        where id = ${candidate.wait_id}
          and run_id = ${candidate.run_id}
          and node_instance_id = ${candidate.node_instance_id}
          and status = 'waiting'
          and expires_at <= clock_timestamp()
        for update
      `;
      if (waitRows.length !== 1) return null;

      const nodeRows = await sql`
        update public.workflow_node_runs
        set status = 'cancelled',
            error = ${sql.json(asPostgresJson(WAIT_EXPIRED_FAILURE))},
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where run_id = ${candidate.run_id}
          and node_instance_id = ${candidate.node_instance_id}
          and status = 'waiting'
        returning 1
      `;
      if (nodeRows.length !== 1) return null;
      await sql`
        update public.workflow_waits
        set status = 'expired', finished_at = clock_timestamp()
        where id = ${candidate.wait_id} and status = 'waiting'
      `;
      await sql`
        update public.workflow_runs
        set status = 'expired',
            cleanup_status = case
              when exists (
                select 1 from public.workflow_node_runs
                where run_id = ${candidate.run_id} and status = 'completed' and has_undo
              ) then 'pending'
              else 'not-required'
            end,
            error = ${sql.json(asPostgresJson(WAIT_EXPIRED_FAILURE))},
            cancellation_requested = true,
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp(),
            version = version + 1
        where id = ${candidate.run_id}
      `;
      await sql`select pg_notify('workflow_cleanup', ${candidate.run_id})`;
      return {
        result: {
          nodeInstanceId: candidate.node_instance_id,
          runId: candidate.run_id,
          waitId: candidate.wait_id,
        },
        signalType: candidate.signal_type,
      };
    });
    if (expired) {
      emitWorkflowLog(this.logger, {
        action: 'expired',
        entity: 'wait',
        failureCode: WAIT_EXPIRED_FAILURE.code,
        nodeInstanceId: expired.result.nodeInstanceId,
        runId: expired.result.runId,
        signalType: expired.signalType,
        waitId: expired.result.waitId,
      });
    }
    return expired?.result ?? null;
  }
}
