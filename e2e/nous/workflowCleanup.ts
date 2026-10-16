import { setTimeout as delay } from 'node:timers/promises';
import type { Sql } from 'postgres';
import { PostgresWorkflowCancellationStore } from '../../apps/backend/src/workflows/postgresWorkflowCancellationStore';
import { raceOperationWithAbort } from '../../apps/backend/src/workflows/workflowStepAttempt';
import { withRunCleanup } from '../../scripts/run-evidence';
import { STACK_READINESS_POLL_INTERVAL_MS, STACK_SHUTDOWN_GRACE_MS } from './stack';

interface AccountRun {
  id: string;
  cancellation_requested: boolean;
  active: boolean;
  workers_running: boolean;
  cleanup_status: string;
}

/** Retire all account work, including UI-started runs, before project FK deletion. */
export async function settleAccountWorkflows(
  sql: Sql,
  userId: string,
  signal?: AbortSignal
): Promise<void> {
  const retirement = new AbortController();
  // Account retirement is graceful shutdown, including for stories without preparation deadlines.
  const timer = setTimeout(
    () =>
      retirement.abort(
        new Error('Account workflow retirement timed out; resources were retained.')
      ),
    STACK_SHUTDOWN_GRACE_MS
  );
  const retirementSignal = signal
    ? AbortSignal.any([signal, retirement.signal])
    : retirement.signal;
  try {
    await withRunCleanup(
      async () => {
        const result = await raceOperationWithAbort(
          () => waitForAccountWorkflows(sql, userId, retirementSignal),
          retirementSignal
        );
        if (result.status === 'failed') throw result.error;
        retirementSignal.throwIfAborted();
      },
      async () => {
        // Release blocked selects and cancellation transactions before the caller closes its pool.
        if (retirementSignal.aborted) await sql.end({ timeout: 0 });
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function waitForAccountWorkflows(
  sql: Sql,
  userId: string,
  signal: AbortSignal
): Promise<void> {
  const cancellations = new PostgresWorkflowCancellationStore(sql);
  while (true) {
    signal.throwIfAborted();
    const runs = await sql<AccountRun[]>`
      select run.id, run.cancellation_requested, run.cleanup_status,
        run.status in ('queued', 'running', 'waiting') as active,
        (exists (select 1 from public.workflow_node_runs node
          where node.run_id = run.id and node.status = 'running')
        or exists (select 1 from public.workflow_undo_runs undo
          where undo.run_id = run.id and undo.status = 'running')) as workers_running
      from public.workflow_runs run where run.user_id = ${userId}
      order by run.id
    `;
    signal.throwIfAborted();
    if (runs.some(run => run.cleanup_status === 'failed'))
      throw new Error('Account workflow compensation failed; resources were retained.');
    const pending = runs.filter(
      run =>
        run.active || run.workers_running || ['pending', 'running'].includes(run.cleanup_status)
    );
    if (pending.length === 0) return;
    for (const run of pending) {
      signal.throwIfAborted();
      if (run.active && !run.cancellation_requested)
        await cancellations.request({ runId: run.id, userId });
    }
    await delay(STACK_READINESS_POLL_INTERVAL_MS, undefined, { signal });
  }
}
