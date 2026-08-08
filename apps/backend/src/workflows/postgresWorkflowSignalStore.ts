import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Sql, TransactionSql } from 'postgres';

import { planWorkflowSignal } from './continuation.js';
import { snapshotDurableJson } from './jsonSnapshot.js';
import type { MaterializedWorkflowEvent, MaterializedWorkflowWait } from './materialization.js';
import { asPostgresJson } from './postgresWorkflowPersistence.js';
import {
  applyWorkflowContinuationPlan,
  createStableWaitIdFactory,
  loadWorkflowNodeSnapshots,
} from './postgresWorkflowPlanStore.js';
import {
  type JsonValue,
  type RegisteredWorkflow,
  WORKFLOW_STEP_POLICIES_VERSION,
  type WorkflowRun,
  type WorkflowStepPolicies,
} from './types.js';
import { lockAuthorizedWorkflowDefinitions } from './workflowDefinitionReconciler.js';
import { WorkflowReplicaOutdatedError, WorkflowSignalError } from './workflowErrors.js';
import { indexWorkflowNodes } from './workflowNodeIndex.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  type WorkflowLogger,
} from './workflowObservability.js';

interface SignalNodeRow {
  node_instance_id: string;
  node_definition_id: string;
  run_id: string;
  status: string;
}

interface SignalRunRow {
  cancellation_requested: boolean;
  definition_hash: string;
  definition_hash_version: number;
  status: WorkflowRun['status'];
  step_policies: WorkflowStepPolicies;
  step_policies_version: number;
  workflow_id: string;
}

interface SignalWaitRow {
  not_expired: boolean;
  signal_schema_version: number;
  signal_type: string;
  status: 'cancelled' | 'consumed' | 'expired' | 'waiting';
}

interface ExistingSignalRow {
  request_payload: JsonValue;
  signal_type: string;
  wait_id: string;
}

export interface WorkflowSignalRequestIdentity {
  requestPayload: unknown;
  signalType: string;
  waitId: string;
}

export interface WorkflowSignalDefinitionBoundary {
  readonly definitionHash: string;
  readonly definitionHashVersion: number;
  readonly workflowId: string;
}

export type WorkflowSignalDefinitionResolver = (
  boundary: WorkflowSignalDefinitionBoundary
) => RegisteredWorkflow | null;

export interface ReceiveWorkflowSignalInput {
  payload: unknown;
  requestKey: string;
  resolveDefinition: WorkflowSignalDefinitionResolver;
  runId: string;
  signalType: string;
  userId: string;
  waitId: string;
}

export type ReceiveWorkflowSignalResult =
  | { runId: string; status: 'replayed' }
  | {
      runId: string;
      status: 'consumed';
      transientEvents: readonly MaterializedWorkflowEvent[];
      workflowId: string;
    };

interface ReceiveWorkflowSignalLogResult {
  newWaits: readonly MaterializedWorkflowWait[];
  nodeInstanceId: string;
  result: ReceiveWorkflowSignalResult;
  signalType: string;
  waitId: string;
}

export const decideWorkflowSignalReplay = (
  existing: WorkflowSignalRequestIdentity | null,
  requested: WorkflowSignalRequestIdentity
): 'new' | 'replayed' => {
  if (!existing) return 'new';
  if (
    existing.waitId === requested.waitId &&
    existing.signalType === requested.signalType &&
    isDeepStrictEqual(existing.requestPayload, requested.requestPayload)
  ) {
    return 'replayed';
  }
  throw new WorkflowSignalError(
    'workflow_signal_request_conflict',
    'The signal request key was already used for a different request.'
  );
};

const resolveSignalDefinition = (
  resolveDefinition: WorkflowSignalDefinitionResolver,
  run: SignalRunRow,
  definitionSupported: boolean
): RegisteredWorkflow => {
  if (!definitionSupported) {
    throw new WorkflowSignalError(
      'workflow_wait_obsolete',
      'The workflow definition required by this signal was intentionally removed.'
    );
  }
  const definition = resolveDefinition({
    definitionHash: run.definition_hash,
    definitionHashVersion: run.definition_hash_version,
    workflowId: run.workflow_id,
  });
  if (
    definition?.id !== run.workflow_id ||
    definition.definitionHash !== run.definition_hash ||
    definition.definitionHashVersion !== run.definition_hash_version
  ) {
    throw new WorkflowReplicaOutdatedError();
  }
  return definition;
};

const isDefinitionSupported = async (sql: TransactionSql, run: SignalRunRow): Promise<boolean> =>
  (
    await lockAuthorizedWorkflowDefinitions(sql, [
      {
        definitionHash: run.definition_hash,
        definitionHashVersion: run.definition_hash_version,
        workflowId: run.workflow_id,
      },
    ])
  ).length === 1;

const lockSignalNode = async (
  sql: TransactionSql,
  waitId: string,
  runId: string,
  userId: string
): Promise<SignalNodeRow> => {
  const rows = await sql<SignalNodeRow[]>`
    select node.run_id, node.node_instance_id, node.node_definition_id, node.status
    from public.workflow_waits wait
    join public.workflow_node_runs node
      on node.run_id = wait.run_id and node.node_instance_id = wait.node_instance_id
    join public.workflow_runs run on run.id = node.run_id
    where wait.id = ${waitId} and wait.run_id = ${runId} and run.user_id = ${userId}
    for update of node
  `;
  const node = rows[0];
  if (!node) {
    throw new WorkflowSignalError('workflow_wait_unknown', 'The workflow wait does not exist.');
  }
  return node;
};

const lockSignalRun = async (
  sql: TransactionSql,
  runId: string,
  userId: string
): Promise<SignalRunRow> => {
  const rows = await sql<SignalRunRow[]>`
    select
      cancellation_requested, definition_hash, definition_hash_version, status,
      step_policies, step_policies_version, workflow_id
    from public.workflow_runs
    where id = ${runId} and user_id = ${userId}
    for update
  `;
  const run = rows[0];
  if (!run)
    throw new WorkflowSignalError('workflow_wait_unknown', 'The workflow wait is unavailable.');
  return run;
};

const lockSignalWait = async (
  sql: TransactionSql,
  waitId: string,
  runId: string,
  nodeInstanceId: string
): Promise<SignalWaitRow> => {
  const rows = await sql<SignalWaitRow[]>`
    select
      status, signal_type, signal_schema_version,
      expires_at > clock_timestamp() as not_expired
    from public.workflow_waits
    where id = ${waitId}
      and run_id = ${runId}
      and node_instance_id = ${nodeInstanceId}
    for update
  `;
  const wait = rows[0];
  if (!wait)
    throw new WorkflowSignalError('workflow_wait_unknown', 'The workflow wait is unavailable.');
  return wait;
};

const loadExistingSignal = async (
  sql: TransactionSql,
  userId: string,
  requestKey: string
): Promise<WorkflowSignalRequestIdentity | null> => {
  const rows = await sql<ExistingSignalRow[]>`
    select wait_id::text, signal_type, request_payload
    from public.workflow_signals
    where user_id = ${userId} and request_key = ${requestKey}
  `;
  const signal = rows[0];
  return signal
    ? {
        requestPayload: signal.request_payload,
        signalType: signal.signal_type,
        waitId: signal.wait_id,
      }
    : null;
};

const assertActiveSignalWait = (
  node: SignalNodeRow,
  run: SignalRunRow,
  wait: SignalWaitRow,
  signalType: string
): void => {
  if (wait.signal_type !== signalType) {
    throw new WorkflowSignalError(
      'workflow_signal_type_mismatch',
      'The signal type does not match this workflow wait.'
    );
  }
  if (!wait.not_expired) {
    throw new WorkflowSignalError('workflow_wait_expired', 'The workflow wait has expired.');
  }
  if (
    wait.status !== 'waiting' ||
    node.status !== 'waiting' ||
    !['queued', 'running', 'waiting'].includes(run.status) ||
    run.cancellation_requested
  ) {
    throw new WorkflowSignalError(
      'workflow_wait_obsolete',
      'The workflow wait is no longer active.'
    );
  }
};

const assertSignalSchemaVersion = (
  definition: RegisteredWorkflow,
  definitionId: string,
  wait: SignalWaitRow,
  signalType: string
): void => {
  const signal = indexWorkflowNodes(definition).get(definitionId)?.signals[signalType];
  if (signal?.schemaVersion !== wait.signal_schema_version) {
    throw new WorkflowSignalError(
      'workflow_wait_obsolete',
      'The workflow signal schema required by this wait is unavailable.'
    );
  }
};

const insertSignal = async (
  sql: TransactionSql,
  input: {
    payload: unknown;
    requestPayload: unknown;
    requestKey: string;
    runId: string;
    schemaVersion: number;
    signalType: string;
    userId: string;
    waitId: string;
  }
): Promise<boolean> => {
  const rows = await sql`
    insert into public.workflow_signals (
      id, wait_id, run_id, user_id, request_key, signal_type, signal_schema_version,
      request_payload, payload
    ) values (
      ${randomUUID()}, ${input.waitId}, ${input.runId}, ${input.userId}, ${input.requestKey},
      ${input.signalType}, ${input.schemaVersion}, ${sql.json(asPostgresJson(input.requestPayload))},
      ${sql.json(asPostgresJson(input.payload))}
    )
    on conflict (user_id, request_key) do nothing
    returning 1
  `;
  return rows.length === 1;
};

export class PostgresWorkflowSignalStore {
  constructor(
    private readonly sql: Sql,
    private readonly logger: WorkflowLogger = consoleWorkflowLogger,
    private readonly enforceCurrentDefinitions = false
  ) {}

  async receive(input: ReceiveWorkflowSignalInput): Promise<ReceiveWorkflowSignalResult> {
    if (!input.requestKey.trim()) throw new Error('requestKey is required.');
    const requestPayload = snapshotDurableJson(input.payload);
    const received = await this.sql.begin(async sql => {
      const node = await lockSignalNode(sql, input.waitId, input.runId, input.userId);
      const run = await lockSignalRun(sql, node.run_id, input.userId);
      const wait = await lockSignalWait(sql, input.waitId, node.run_id, node.node_instance_id);
      const requested = {
        requestPayload,
        signalType: input.signalType,
        waitId: input.waitId,
      };
      const existing = await loadExistingSignal(sql, input.userId, input.requestKey);
      if (decideWorkflowSignalReplay(existing, requested) === 'replayed') {
        return {
          newWaits: [],
          nodeInstanceId: node.node_instance_id,
          result: { runId: node.run_id, status: 'replayed' as const },
          signalType: input.signalType,
          waitId: input.waitId,
        } satisfies ReceiveWorkflowSignalLogResult;
      }
      if (run.step_policies_version !== WORKFLOW_STEP_POLICIES_VERSION) {
        throw new WorkflowSignalError(
          'workflow_wait_obsolete',
          'The workflow policy snapshot required by this signal is unsupported.'
        );
      }

      const definition = resolveSignalDefinition(
        input.resolveDefinition,
        run,
        !this.enforceCurrentDefinitions || (await isDefinitionSupported(sql, run))
      );
      assertActiveSignalWait(node, run, wait, input.signalType);
      assertSignalSchemaVersion(definition, node.node_definition_id, wait, input.signalType);
      const nodes = await loadWorkflowNodeSnapshots(sql, node.run_id);
      const plan = planWorkflowSignal({
        definition,
        nodeInstanceId: node.node_instance_id,
        nodes,
        payload: requestPayload,
        stepPolicies: run.step_policies,
        waitIdForNode: createStableWaitIdFactory(),
      });
      const inserted = await insertSignal(sql, {
        payload: plan.signalPayload,
        requestPayload,
        requestKey: input.requestKey,
        runId: node.run_id,
        schemaVersion: plan.signalSchemaVersion,
        signalType: plan.signalType,
        userId: input.userId,
        waitId: input.waitId,
      });
      if (!inserted) {
        const raced = await loadExistingSignal(sql, input.userId, input.requestKey);
        if (decideWorkflowSignalReplay(raced, requested) === 'replayed') {
          return {
            newWaits: [],
            nodeInstanceId: node.node_instance_id,
            result: { runId: node.run_id, status: 'replayed' as const },
            signalType: input.signalType,
            waitId: input.waitId,
          } satisfies ReceiveWorkflowSignalLogResult;
        }
        throw new WorkflowSignalError(
          'workflow_wait_obsolete',
          'The workflow wait has already consumed another signal.'
        );
      }

      await applyWorkflowContinuationPlan(
        sql,
        { nodeInstanceId: node.node_instance_id, runId: node.run_id },
        plan,
        'completed',
        async update => {
          if (update.status !== 'completed') throw new Error('Expected a completed signal wait.');
          const nodeRows = await sql`
            update public.workflow_node_runs
            set status = 'completed', output = ${sql.json(asPostgresJson(update.output))},
                error = null, completed_at = clock_timestamp(), updated_at = clock_timestamp()
            where run_id = ${node.run_id}
              and node_instance_id = ${node.node_instance_id}
              and status = 'waiting'
            returning 1
          `;
          if (nodeRows.length !== 1) {
            throw new WorkflowSignalError(
              'workflow_wait_obsolete',
              'The workflow wait is no longer active.'
            );
          }
          const waitRows = await sql`
            update public.workflow_waits
            set status = 'consumed', consumed_at = clock_timestamp(), finished_at = clock_timestamp()
            where id = ${input.waitId} and run_id = ${node.run_id} and status = 'waiting'
            returning 1
          `;
          if (waitRows.length !== 1) {
            throw new WorkflowSignalError(
              'workflow_wait_obsolete',
              'The workflow wait is no longer active.'
            );
          }
        }
      );
      return {
        newWaits: plan.newWaits,
        nodeInstanceId: node.node_instance_id,
        result: {
          runId: node.run_id,
          status: 'consumed' as const,
          transientEvents: plan.transientEvents,
          workflowId: run.workflow_id,
        },
        signalType: plan.signalType,
        waitId: input.waitId,
      } satisfies ReceiveWorkflowSignalLogResult;
    });
    emitWorkflowLog(this.logger, {
      action: received.result.status === 'consumed' ? 'signal-consumed' : 'signal-replayed',
      entity: 'wait',
      nodeInstanceId: received.nodeInstanceId,
      runId: received.result.runId,
      signalType: received.signalType,
      waitId: received.waitId,
    });
    for (const wait of received.newWaits) {
      emitWorkflowLog(this.logger, {
        action: 'created',
        entity: 'wait',
        nodeInstanceId: wait.nodeInstanceId,
        runId: received.result.runId,
        signalType: wait.signalType,
        waitId: wait.waitId,
      });
    }
    return received.result;
  }
}
