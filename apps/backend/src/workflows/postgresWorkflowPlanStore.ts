import { randomUUID } from 'node:crypto';

import type { TransactionSql } from 'postgres';

import type {
  WorkflowContinuationPlan,
  WorkflowNodeSnapshot,
  WorkflowNodeUpdate,
} from './continuation.js';
import type { MaterializedWorkflowWait } from './materialization.js';
import {
  appendWorkflowOutboxEvents,
  asPostgresJson,
  insertMaterializedNode,
} from './postgresWorkflowPersistence.js';
import { parseStepFailure } from './retryPolicy.js';
import type { StepFailure } from './types.js';

interface NodeSnapshotRow {
  error: unknown;
  has_undo: boolean;
  input: unknown;
  item_key: string | null;
  kind: WorkflowNodeSnapshot['kind'];
  max_attempts: number;
  node_definition_id: string;
  node_instance_id: string;
  output: unknown;
  parent_instance_id: string | null;
  runtime_state: Record<string, unknown> | null;
  status: WorkflowNodeSnapshot['status'];
  timeout_ms: number;
}

interface RunActivityRow {
  active_nodes: number;
  active_waits: number;
  executable_nodes: number;
  queued_nodes: number;
}

const mapNodeSnapshot = (row: NodeSnapshotRow): WorkflowNodeSnapshot => ({
  definitionId: row.node_definition_id,
  hasUndo: row.has_undo,
  input: row.input,
  instanceId: row.node_instance_id,
  ...(row.item_key === null ? {} : { itemKey: row.item_key }),
  kind: row.kind,
  maxAttempts: row.max_attempts,
  ...(row.status === 'completed' ? { output: row.output } : {}),
  parentInstanceId: row.parent_instance_id ?? undefined,
  ...(row.status === 'failed' && row.error !== null
    ? { failure: parseStepFailure(row.error) }
    : {}),
  runtimeState: row.runtime_state ?? undefined,
  status: row.status,
  timeoutMs: row.timeout_ms,
});

export const loadWorkflowNodeSnapshots = async (
  sql: TransactionSql,
  runId: string
): Promise<WorkflowNodeSnapshot[]> => {
  const rows = await sql<NodeSnapshotRow[]>`
    select
      node_instance_id, node_definition_id, parent_instance_id, item_key, kind, status,
      input, output, error, runtime_state, max_attempts, timeout_ms, has_undo
    from public.workflow_node_runs
    where run_id = ${runId}
    order by created_at, node_instance_id
  `;
  return rows.map(mapNodeSnapshot);
};

export const createStableWaitIdFactory = (): ((nodeInstanceId: string) => string) => {
  const waitIds = new Map<string, string>();
  return nodeInstanceId => {
    const existing = waitIds.get(nodeInstanceId);
    if (existing) return existing;
    const created = randomUUID();
    waitIds.set(nodeInstanceId, created);
    return created;
  };
};

const assertUpdated = (rows: readonly unknown[], message: string): void => {
  if (rows.length !== 1) throw new Error(message);
};

const applyFrameUpdate = async (
  sql: TransactionSql,
  runId: string,
  update: WorkflowNodeUpdate
): Promise<void> => {
  let rows: readonly unknown[];
  switch (update.status) {
    case 'completed':
      rows = await sql`
        update public.workflow_node_runs
        set status = 'completed',
            output = ${sql.json(asPostgresJson(update.output))},
            error = null,
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where run_id = ${runId} and node_instance_id = ${update.instanceId}
        returning 1
      `;
      break;
    case 'failed':
      rows = await sql`
        update public.workflow_node_runs
        set status = 'failed',
            error = ${sql.json(asPostgresJson(update.failure))},
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where run_id = ${runId} and node_instance_id = ${update.instanceId}
        returning 1
      `;
      break;
    case 'waiting':
      rows = await sql`
        update public.workflow_node_runs
        set status = 'waiting',
            runtime_state = ${sql.json(asPostgresJson(update.runtimeState))},
            error = null,
            completed_at = null,
            updated_at = clock_timestamp()
        where run_id = ${runId} and node_instance_id = ${update.instanceId}
        returning 1
      `;
      break;
  }
  assertUpdated(rows, `Workflow frame ${update.instanceId} could not be updated.`);
};

const insertWaits = async (
  sql: TransactionSql,
  runId: string,
  waits: readonly MaterializedWorkflowWait[]
): Promise<void> => {
  for (const wait of waits) {
    await sql`
      insert into public.workflow_waits (
        id, run_id, node_instance_id, signal_type, signal_schema_version
      ) values (
        ${wait.waitId}, ${runId}, ${wait.nodeInstanceId}, ${wait.signalType}, ${wait.schemaVersion}
      )
    `;
  }
};

const loadRunActivity = async (sql: TransactionSql, runId: string): Promise<RunActivityRow> => {
  const rows = await sql<RunActivityRow[]>`
    select
      count(*) filter (
        where status in ('queued', 'running', 'retrying', 'waiting')
      )::integer as active_nodes,
      count(*) filter (
        where status in ('queued', 'running', 'retrying')
      )::integer as executable_nodes,
      count(*) filter (where status in ('queued', 'retrying'))::integer as queued_nodes,
      (
        select count(*)::integer
        from public.workflow_waits
        where run_id = ${runId} and status = 'waiting'
      ) as active_waits
    from public.workflow_node_runs
    where run_id = ${runId}
  `;
  const activity = rows[0];
  if (!activity) throw new Error(`Workflow run ${runId} activity could not be read.`);
  return activity;
};

export const failWorkflowRun = async (
  sql: TransactionSql,
  runId: string,
  failure: StepFailure
): Promise<void> => {
  const rows = await sql`
    update public.workflow_runs
    set status = 'failed',
        cleanup_status = case
          when exists (
            select 1 from public.workflow_node_runs
            where run_id = ${runId} and status = 'completed' and has_undo
          ) then 'pending'
          else 'not-required'
        end,
        error = ${sql.json(asPostgresJson(failure))},
        cancellation_requested = true,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        version = version + 1
    where id = ${runId} and status in ('queued', 'running', 'waiting')
    returning 1
  `;
  if (rows.length !== 1) throw new Error(`Workflow run ${runId} could not be failed.`);
};

const updateRunFromPlan = async (
  sql: TransactionSql,
  runId: string,
  plan: WorkflowContinuationPlan
): Promise<void> => {
  if (plan.terminalFailure) {
    await failWorkflowRun(sql, runId, plan.terminalFailure.failure);
    return;
  }

  const activity = await loadRunActivity(sql, runId);
  if (Object.hasOwn(plan, 'completedOutput')) {
    if (activity.active_nodes !== 0 || activity.active_waits !== 0) {
      throw new Error(`Workflow run ${runId} cannot complete with active work.`);
    }
    await sql`
      update public.workflow_runs
      set status = 'completed',
          output = ${sql.json(asPostgresJson(plan.completedOutput))},
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp(),
          version = version + 1
      where id = ${runId}
    `;
    return;
  }

  if (activity.executable_nodes === 0 && activity.active_waits === 0) {
    throw new Error(`Workflow run ${runId} has no continuation.`);
  }
  await sql`
    update public.workflow_runs
    set status = ${activity.executable_nodes > 0 ? 'running' : 'waiting'},
        updated_at = clock_timestamp(),
        version = version + 1
    where id = ${runId}
  `;
  if (activity.queued_nodes > 0) await sql`select pg_notify('workflow_ready', ${runId})`;
};

export const applyWorkflowContinuationPlan = async (
  sql: TransactionSql,
  boundary: { nodeInstanceId: string; runId: string },
  plan: WorkflowContinuationPlan,
  boundaryStatus: 'completed' | 'failed',
  applyBoundary: (update: WorkflowNodeUpdate) => Promise<void>
): Promise<void> => {
  const boundaryUpdate = plan.nodeUpdates.find(
    update => update.instanceId === boundary.nodeInstanceId
  );
  if (boundaryUpdate?.status !== boundaryStatus) {
    throw new Error(`Workflow plan did not ${boundaryStatus} ${boundary.nodeInstanceId}.`);
  }
  await applyBoundary(boundaryUpdate);

  for (const update of plan.nodeUpdates) {
    if (update.instanceId !== boundary.nodeInstanceId) {
      await applyFrameUpdate(sql, boundary.runId, update);
    }
  }
  for (const node of plan.newNodes) await insertMaterializedNode(sql, boundary.runId, node);
  await insertWaits(sql, boundary.runId, plan.newWaits);
  await appendWorkflowOutboxEvents(sql, boundary.runId, plan.durableEvents);
  await updateRunFromPlan(sql, boundary.runId, plan);
};
