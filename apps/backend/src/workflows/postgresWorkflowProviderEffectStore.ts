import type { Sql } from 'postgres';

import { asPostgresJson, insertWorkflowAiUsage } from './postgresWorkflowPersistence.js';
import type { JsonValue } from './types.js';
import type { WorkflowAiUsageRecord } from './workflowAiMetering.js';
import { WorkflowLeaseLostError } from './workflowErrors.js';

export interface RecordWorkflowProviderResultInput {
  idempotencyKey: string;
  nodeInstanceId: string;
  output: JsonValue;
  aiUsage?: readonly WorkflowAiUsageRecord[];
  runId: string;
}

interface WorkflowProviderResultRow {
  ai_usage: WorkflowAiUsageRecord[];
  finalized: boolean;
  idempotency_key: string;
  node_instance_id: string;
  output: JsonValue | null;
  run_id: string;
}

const PROVIDER_EFFECT_IDENTITY_MISMATCH =
  'Workflow provider idempotency key belongs to a different step identity.';

const matchesProviderEffectIdentity = (
  row: WorkflowProviderResultRow,
  input: Omit<RecordWorkflowProviderResultInput, 'output'>
): boolean =>
  row.idempotency_key === input.idempotencyKey &&
  row.run_id === input.runId &&
  row.node_instance_id === input.nodeInstanceId;

const mergeAiUsage = (
  existing: readonly WorkflowAiUsageRecord[],
  pending: readonly WorkflowAiUsageRecord[]
): WorkflowAiUsageRecord[] => {
  const merged = [...existing];
  const ids = new Set(existing.map(usage => usage.id));
  for (const usage of pending) {
    if (ids.has(usage.id)) continue;
    ids.add(usage.id);
    merged.push(usage);
  }
  return merged;
};

const flushAiUsage = async (sql: Sql, row: WorkflowProviderResultRow): Promise<JsonValue> => {
  if (row.finalized || row.output === null) throw new WorkflowLeaseLostError();
  await insertWorkflowAiUsage(sql, row.ai_usage);
  return row.output;
};

export interface WorkflowProviderEffectStore {
  getResult(
    input: Omit<RecordWorkflowProviderResultInput, 'output'>
  ): Promise<JsonValue | undefined>;
  recordResult(input: RecordWorkflowProviderResultInput): Promise<JsonValue>;
}

export const createPostgresWorkflowProviderEffectStore = (
  sql: Sql
): WorkflowProviderEffectStore => ({
  async getResult(input) {
    const rows = await sql<WorkflowProviderResultRow[]>`
      select idempotency_key, run_id, node_instance_id, output, ai_usage, finalized
      from public.workflow_provider_effect_results
      where idempotency_key = ${input.idempotencyKey}
    `;
    const row = rows[0];
    if (!row) return undefined;
    if (!matchesProviderEffectIdentity(row, input)) {
      throw new Error(PROVIDER_EFFECT_IDENTITY_MISMATCH);
    }
    return flushAiUsage(sql, row);
  },

  /**
   * The first valid result persisted for a step identity is authoritative. A conflicting insert
   * waits for the winner and returns its result, including when two provider calls overlap.
   */
  async recordResult(input) {
    const authoritative = await sql.begin(async transaction => {
      const activeRows = await transaction<Array<{ status: string }>>`
        select status
        from public.workflow_node_runs
        where run_id = ${input.runId} and node_instance_id = ${input.nodeInstanceId}
        for share
      `;
      if (!['running', 'retrying'].includes(activeRows[0]?.status ?? '')) {
        throw new WorkflowLeaseLostError();
      }
      await transaction`
        insert into public.workflow_provider_effect_results (
          idempotency_key,
          run_id,
          node_instance_id,
          output,
          ai_usage
        ) values (
          ${input.idempotencyKey},
          ${input.runId},
          ${input.nodeInstanceId},
          ${transaction.json(asPostgresJson(input.output))},
          ${transaction.json(asPostgresJson(input.aiUsage ?? []))}
        )
        on conflict do nothing
      `;
      const rows = await transaction<WorkflowProviderResultRow[]>`
        select idempotency_key, run_id, node_instance_id, output, ai_usage, finalized
        from public.workflow_provider_effect_results
        where idempotency_key = ${input.idempotencyKey}
        for update
      `;
      const row = rows[0];
      if (!row || !matchesProviderEffectIdentity(row, input)) {
        throw new Error(PROVIDER_EFFECT_IDENTITY_MISMATCH);
      }
      if (row.finalized || row.output === null) throw new WorkflowLeaseLostError();

      const aiUsage = mergeAiUsage(row.ai_usage, input.aiUsage ?? []);
      if (aiUsage.length !== row.ai_usage.length) {
        await transaction`
          update public.workflow_provider_effect_results
          set ai_usage = ${transaction.json(asPostgresJson(aiUsage))}
          where idempotency_key = ${input.idempotencyKey}
        `;
      }
      return { ...row, ai_usage: aiUsage };
    });
    return flushAiUsage(sql, authoritative);
  },
});
