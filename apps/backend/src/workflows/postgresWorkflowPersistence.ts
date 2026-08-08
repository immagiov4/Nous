import { randomUUID } from 'node:crypto';

import type postgres from 'postgres';

import type { MaterializedWorkflowEvent, MaterializedWorkflowNode } from './materialization.js';
import type { WorkflowDefinitionBoundary } from './types.js';
import type { WorkflowAiUsageRecord } from './workflowAiMetering.js';

interface EventSequenceRow {
  next_event_sequence: string | number;
}

export const asPostgresJson = (value: unknown): postgres.JSONValue => value as postgres.JSONValue;

export const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const toPostgresDefinitionBoundaryArrays = (
  definitions: readonly WorkflowDefinitionBoundary[]
) => ({
  definitionHashes: definitions.map(definition => definition.definitionHash),
  definitionHashVersions: definitions.map(definition => definition.definitionHashVersion),
  workflowIds: definitions.map(definition => definition.workflowId),
});

export const insertMaterializedNode = async (
  sql: postgres.TransactionSql,
  runId: string,
  node: MaterializedWorkflowNode
): Promise<void> => {
  await sql`
    insert into public.workflow_node_runs (
      run_id, node_instance_id, node_definition_id, parent_instance_id, item_key,
      kind, status, input, output, runtime_state, max_attempts, timeout_ms, has_undo,
      completed_at
    ) values (
      ${runId}, ${node.instanceId}, ${node.definitionId}, ${node.parentInstanceId ?? null},
      ${node.itemKey ?? null}, ${node.kind}, ${node.status},
      ${sql.json(asPostgresJson(node.input))},
      ${node.output === undefined ? null : sql.json(asPostgresJson(node.output))},
      ${node.runtimeState === undefined ? null : sql.json(asPostgresJson(node.runtimeState))},
      ${node.maxAttempts}, ${node.timeoutMs}, ${node.hasUndo},
      ${node.status === 'completed' ? sql`clock_timestamp()` : null}
    )
  `;
};

export const insertOutboxEvents = async (
  sql: postgres.TransactionSql,
  runId: string,
  firstSequence: bigint,
  events: readonly MaterializedWorkflowEvent[]
): Promise<void> => {
  for (const [index, event] of events.entries()) {
    const sequence = (firstSequence + BigInt(index)).toString();
    await sql`
      insert into public.workflow_outbox (
        id, run_id, sequence, event_type, schema_version, payload
      ) values (
        ${randomUUID()}, ${runId}, ${sequence},
        ${event.eventType}, ${event.schemaVersion}, ${sql.json(asPostgresJson(event.payload))}
      )
    `;
  }
  if (events.length > 0) {
    await sql`select pg_notify('workflow_notification_ready', ${runId})`;
  }
};

export const appendWorkflowOutboxEvents = async (
  sql: postgres.TransactionSql,
  runId: string,
  events: readonly MaterializedWorkflowEvent[]
): Promise<void> => {
  if (events.length === 0) return;
  const sequenceRows = await sql<EventSequenceRow[]>`
    update public.workflow_runs
    set next_event_sequence = next_event_sequence + ${events.length}
    where id = ${runId}
    returning next_event_sequence
  `;
  const sequence = sequenceRows[0];
  if (!sequence) throw new Error(`Workflow run ${runId} event sequence could not be advanced.`);
  const firstSequence = BigInt(sequence.next_event_sequence) - BigInt(events.length) + 1n;
  await insertOutboxEvents(sql, runId, firstSequence, events);
};

export const insertWorkflowAiUsage = async (
  sql: postgres.Sql | postgres.TransactionSql,
  usageRecords: readonly WorkflowAiUsageRecord[]
): Promise<void> => {
  for (const usage of usageRecords) {
    await sql`
      insert into public.workflow_ai_usage (
        id, run_id, node_instance_id, attempt_number, provider, model, input_tokens,
        output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, provider_cost
      ) values (
        ${usage.id}, ${usage.runId}, ${usage.nodeInstanceId}, ${usage.attemptNumber}, ${usage.provider},
        ${usage.model}, ${usage.inputTokens ?? null}, ${usage.outputTokens ?? null},
        ${usage.reasoningTokens ?? null}, ${usage.cacheReadTokens ?? null},
        ${usage.cacheWriteTokens ?? null}, ${usage.providerCost ?? null}
      )
      on conflict (id) do nothing
    `;
  }
};
