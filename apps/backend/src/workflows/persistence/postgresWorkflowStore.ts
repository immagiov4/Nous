import postgres, { type Sql, type TransactionSql } from 'postgres';
import { PostgresProjectAssetStore } from '../../projects/postgresProjectAssetStore.js';
import type { ProjectAssetObjectStorage } from '../../projects/projectAsset.js';
import { PostgresProjectAssetDeletionQueue } from '../../projects/projectAssetDeletionQueue.js';
import { buildSha256HexDigest } from '../../utils/hash.js';
import { PostgresCourseGenerationPersistence } from '../courseGenerationPersistence.js';
import { PostgresLessonGenerationPersistence } from '../lessonGenerationPersistence.js';
import { PostgresLessonVisualPersistence } from '../lessonVisualPersistence.js';
import type { WorkflowStartMaterialization } from '../materialization.js';
import { PostgresProjectRevisionInbox } from '../postgresProjectRevisionInbox.js';
import { PostgresWorkflowCancellationStore } from '../postgresWorkflowCancellationStore.js';
import {
  type CheckpointWorkflowStepInput,
  checkpointWorkflowStep,
  type WorkflowCheckpointResult,
} from '../postgresWorkflowCheckpoint.js';
import { PostgresWorkflowOutboxStore } from '../postgresWorkflowOutboxStore.js';
import {
  asPostgresJson,
  insertMaterializedNode,
  insertOutboxEvents,
  insertWorkflowAiUsage,
  toIsoString,
} from '../postgresWorkflowPersistence.js';
import {
  createPostgresWorkflowProviderEffectStore,
  type WorkflowProviderEffectStore,
} from '../postgresWorkflowProviderEffectStore.js';
import { PostgresWorkflowSignalStore } from '../postgresWorkflowSignalStore.js';
import { PostgresWorkflowStepStore } from '../postgresWorkflowStepStore.js';
import { PostgresWorkflowUndoStore } from '../postgresWorkflowUndoStore.js';
import { PostgresWorkflowWaitStore } from '../postgresWorkflowWaitStore.js';
import {
  PostgresWorkflowWakeSource,
  type WorkflowListenClientFactory,
} from '../postgresWorkflowWakeSource.js';
import { createCorrelationId } from '../requestObservability.js';
import { parseStepFailure } from '../retryPolicy.js';
import type { WorkflowRuntimeStore } from '../runtime/workflowRuntimeWorker.js';
import { canonicalJson } from '../schemaFingerprint.js';
import type { JsonValue, WorkflowRun, WorkflowStepPolicies } from '../types.js';
import type { WorkflowAiUsageRecord } from '../workflowAiMetering.js';
import { PostgresWorkflowDefinitionReconciliationStore } from '../workflowDefinitionReconciler.js';
import {
  WorkflowReplicaOutdatedError,
  WorkflowRunRequestConflictError,
} from '../workflowErrors.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  type WorkflowLogger,
} from '../workflowObservability.js';
import {
  createWorkflowRunState,
  type WorkflowDurableEventState,
  type WorkflowNodeRunState,
  type WorkflowRunState,
  type WorkflowSignalWaitState,
} from '../workflowReadModel.js';

interface WorkflowRunRow {
  cancellation_requested: boolean;
  cleanup_status: WorkflowRun['cleanupStatus'];
  completed_at: Date | string | null;
  correlation_id: string;
  created_at: Date | string;
  definition_hash: string;
  definition_hash_version: number;
  id: string;
  input: unknown;
  error: unknown;
  output: unknown;
  project_id: string | null;
  request_key: string;
  resolved_config: unknown;
  step_policies: WorkflowStepPolicies;
  step_policies_version: number;
  status: WorkflowRun['status'];
  started_at: Date | string | null;
  updated_at: Date | string;
  user_id: string;
  workflow_id: string;
}

interface WorkflowRequestRunRow extends WorkflowRunRow {
  request_fingerprint: string | null;
}

interface WorkflowRunStateRow extends WorkflowRunRow {
  events: Array<{
    createdAt: string;
    eventType: string;
    payload: JsonValue;
    schemaVersion: number;
    sequence: string;
  }>;
  nodes: Array<{
    attemptCount: number;
    availableAt: string;
    completedAt: string | null;
    createdAt: string;
    definitionId: string;
    error: unknown;
    instanceId: string;
    itemKey: string | null;
    kind: WorkflowNodeRunState['kind'];
    maxAttempts: number;
    parentInstanceId: string | null;
    status: WorkflowNodeRunState['status'];
    updatedAt: string;
  }>;
  waits: Array<{
    createdAt: string;
    expiresAt: string;
    nodeInstanceId: string;
    schemaVersion: number;
    signalType: string;
    waitId: string;
  }>;
}

export interface CreateWorkflowRunInput {
  config: unknown;
  correlationId?: string;
  /** User-wide active-work identity; callers namespace it to share exclusion across workflows. */
  dedupeKey?: string;
  definitionHash: string;
  definitionHashVersion: number;
  id: string;
  /** Stable request semantics when persisted workflow input contains generated identities. */
  idempotencyInput?: unknown;
  input: unknown;
  /** Maps only the immediately previous persisted input shape for a rolling-deploy replay. */
  mapPreviousIdempotencyInput?: (workflowInput: unknown) => JsonValue | undefined;
  materialization: WorkflowStartMaterialization;
  projectId?: string;
  requestKey: string;
  userId: string;
  workflowId: string;
}

export interface PostgresWorkflowStoreOptions {
  readonly databaseUrl?: string;
  readonly definitionDeploymentScope?: string;
  readonly enforceCurrentDefinitions?: boolean;
  readonly listenClientFactory?: WorkflowListenClientFactory;
  readonly logger?: WorkflowLogger;
  readonly projectAssetStorage?: ProjectAssetObjectStorage;
  readonly sqlClient?: Sql;
  readonly workflowSetVersion?: number;
}

const assertCurrentDefinition = async (
  sql: TransactionSql,
  input: Pick<CreateWorkflowRunInput, 'definitionHash' | 'definitionHashVersion' | 'workflowId'>
): Promise<void> => {
  const rows = await sql`
    select 1
    from public.workflow_definition_deployments
    where workflow_id = ${input.workflowId}
      and current_deployment #>> '{current,definitionHash}' = ${input.definitionHash}
      and (current_deployment #>> '{current,definitionHashVersion}')::integer =
        ${input.definitionHashVersion}
    for share
  `;
  if (rows.length === 0) throw new WorkflowReplicaOutdatedError();
};

const workflowRequestFingerprint = (
  input: Pick<CreateWorkflowRunInput, 'idempotencyInput' | 'input' | 'projectId'>
): string =>
  buildSha256HexDigest(
    new TextEncoder().encode(
      canonicalJson({
        input: input.idempotencyInput === undefined ? input.input : input.idempotencyInput,
        projectId: input.projectId ?? null,
      })
    )
  );

const matchesPreviousRequestIdentity = (
  input: CreateWorkflowRunInput,
  requestRun: WorkflowRequestRunRow,
  requestedFingerprint: string
): boolean => {
  if ((requestRun.project_id ?? undefined) !== input.projectId) return false;
  const isOriginalRunRequest =
    requestRun.workflow_id === input.workflowId && requestRun.request_key === input.requestKey;
  if (!isOriginalRunRequest) return false;

  const storedFingerprint = requestRun.request_fingerprint;
  const previousWorkflowFingerprint = workflowRequestFingerprint({
    input: requestRun.input,
    ...(requestRun.project_id === null ? {} : { projectId: requestRun.project_id }),
  });
  const isKnownPreviousFingerprint =
    storedFingerprint === previousWorkflowFingerprint ||
    storedFingerprint === null ||
    storedFingerprint === `legacy:${requestRun.id}`;
  if (!isKnownPreviousFingerprint) return false;
  if (previousWorkflowFingerprint === requestedFingerprint) return true;
  if (!input.mapPreviousIdempotencyInput) return false;

  const previousIdempotencyInput = input.mapPreviousIdempotencyInput(requestRun.input);
  if (previousIdempotencyInput === undefined) return false;
  return (
    workflowRequestFingerprint({
      idempotencyInput: previousIdempotencyInput,
      input: requestRun.input,
      ...(requestRun.project_id === null ? {} : { projectId: requestRun.project_id }),
    }) === requestedFingerprint
  );
};

const lockRunIdentity = async (
  sql: TransactionSql,
  input: CreateWorkflowRunInput
): Promise<void> => {
  const identities = [
    `request:${input.userId}:${input.workflowId}:${input.requestKey}`,
    ...(input.dedupeKey ? [`dedupe:${input.userId}:${input.dedupeKey}`] : []),
  ].sort((left, right) => left.localeCompare(right));

  for (const identity of identities) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
  }
};

const findRunByRequestKey = async (
  sql: TransactionSql,
  input: Pick<CreateWorkflowRunInput, 'requestKey' | 'userId' | 'workflowId'>
): Promise<WorkflowRequestRunRow | undefined> => {
  const rows = await sql<WorkflowRequestRunRow[]>`
    select run.*, request.request_fingerprint
    from public.workflow_run_requests request
    join public.workflow_runs run
      on run.id = request.run_id and run.user_id = request.user_id
    where request.user_id = ${input.userId}
      and request.workflow_id = ${input.workflowId}
      and request.request_key = ${input.requestKey}
    limit 1
    for update of run, request
  `;
  return rows[0];
};

const assertMatchingRequestFingerprint = async (
  sql: TransactionSql,
  input: CreateWorkflowRunInput,
  requestRun: WorkflowRequestRunRow,
  requestedFingerprint: string
): Promise<void> => {
  if (requestRun.request_fingerprint === requestedFingerprint) return;
  if (!matchesPreviousRequestIdentity(input, requestRun, requestedFingerprint)) {
    throw new WorkflowRunRequestConflictError();
  }

  const rows = await sql`
    update public.workflow_run_requests
    set request_fingerprint = ${requestedFingerprint}
    where user_id = ${input.userId}
      and workflow_id = ${input.workflowId}
      and request_key = ${input.requestKey}
      and request_fingerprint is not distinct from ${requestRun.request_fingerprint}
    returning 1
  `;
  if (rows.length !== 1) throw new Error('Workflow request fingerprint could not be upgraded.');
};

const findActiveRunByDedupeKey = async (
  sql: TransactionSql,
  input: Pick<CreateWorkflowRunInput, 'dedupeKey' | 'userId'>
): Promise<WorkflowRunRow | undefined> => {
  if (!input.dedupeKey) return undefined;
  const rows = await sql<WorkflowRunRow[]>`
    select *
    from public.workflow_runs
    where user_id = ${input.userId}
      and dedupe_key = ${input.dedupeKey}
      and status in ('queued', 'running', 'waiting')
    limit 1
    for update
  `;
  return rows[0];
};

const bindRunRequest = async (
  sql: TransactionSql,
  input: Pick<CreateWorkflowRunInput, 'requestKey' | 'userId' | 'workflowId'>,
  runId: string,
  requestFingerprint: string
): Promise<void> => {
  await sql`
    insert into public.workflow_run_requests (
      user_id, workflow_id, request_key, run_id, request_fingerprint
    ) values (
      ${input.userId}, ${input.workflowId}, ${input.requestKey}, ${runId}, ${requestFingerprint}
    )
  `;
};

const mapRun = (row: WorkflowRunRow): WorkflowRun => ({
  cancellationRequested: row.cancellation_requested,
  cleanupStatus: row.cleanup_status,
  ...(row.completed_at === null ? {} : { completedAt: toIsoString(row.completed_at) }),
  createdAt: toIsoString(row.created_at),
  correlationId: row.correlation_id,
  definitionHash: row.definition_hash,
  definitionHashVersion: row.definition_hash_version,
  id: row.id,
  input: row.input,
  ...(row.error === null ? {} : { error: parseStepFailure(row.error) }),
  ...(row.status === 'completed' ? { output: row.output } : {}),
  ...(row.project_id ? { projectId: row.project_id } : {}),
  requestKey: row.request_key,
  resolvedConfig: row.resolved_config,
  stepPolicies: row.step_policies,
  stepPoliciesVersion: row.step_policies_version,
  status: row.status,
  ...(row.started_at === null ? {} : { startedAt: toIsoString(row.started_at) }),
  updatedAt: toIsoString(row.updated_at),
  userId: row.user_id,
  workflowId: row.workflow_id,
});

const mapNodeRunState = (row: WorkflowRunStateRow['nodes'][number]): WorkflowNodeRunState => ({
  attemptCount: row.attemptCount,
  availableAt: toIsoString(row.availableAt),
  ...(row.completedAt === null ? {} : { completedAt: toIsoString(row.completedAt) }),
  createdAt: toIsoString(row.createdAt),
  definitionId: row.definitionId,
  ...(row.error === null ? {} : { error: parseStepFailure(row.error) }),
  instanceId: row.instanceId,
  ...(row.itemKey === null ? {} : { itemKey: row.itemKey }),
  kind: row.kind,
  maxAttempts: row.maxAttempts,
  ...(row.parentInstanceId === null ? {} : { parentInstanceId: row.parentInstanceId }),
  status: row.status,
  updatedAt: toIsoString(row.updatedAt),
});

const mapEventState = (row: WorkflowRunStateRow['events'][number]): WorkflowDurableEventState => ({
  createdAt: toIsoString(row.createdAt),
  eventType: row.eventType,
  payload: row.payload,
  schemaVersion: row.schemaVersion,
  sequence: row.sequence,
});

const mapWaitState = (row: WorkflowRunStateRow['waits'][number]): WorkflowSignalWaitState => ({
  createdAt: toIsoString(row.createdAt),
  expiresAt: toIsoString(row.expiresAt),
  nodeInstanceId: row.nodeInstanceId,
  schemaVersion: row.schemaVersion,
  signalType: row.signalType,
  waitId: row.waitId,
});

const isCompletedMaterialization = (materialization: WorkflowStartMaterialization): boolean =>
  Object.hasOwn(materialization, 'completedOutput');

const initialRunStatus = (materialization: WorkflowStartMaterialization): WorkflowRun['status'] => {
  if (isCompletedMaterialization(materialization)) return 'completed';
  if (materialization.nodes.some(node => node.status === 'queued')) return 'queued';
  if (materialization.waits.length > 0) return 'waiting';
  throw new Error('An incomplete workflow must contain queued work or an active wait.');
};

export class PostgresWorkflowStore implements WorkflowRuntimeStore {
  private readonly enforceCurrentDefinitions: boolean;
  private readonly logger: WorkflowLogger;
  private readonly ownsConnection: boolean;
  private readonly sql: Sql;
  readonly cancellation: PostgresWorkflowCancellationStore;
  readonly courseGenerationPersistence: PostgresCourseGenerationPersistence;
  readonly definitionReconciliation: PostgresWorkflowDefinitionReconciliationStore;
  readonly lessonGenerationPersistence: PostgresLessonGenerationPersistence;
  readonly lessonVisualPersistence: PostgresLessonVisualPersistence;
  readonly outbox: PostgresWorkflowOutboxStore;
  readonly projectRevisionInbox: PostgresProjectRevisionInbox;
  readonly projectAssetDeletions: PostgresProjectAssetDeletionQueue;
  readonly projectAssets: PostgresProjectAssetStore;
  readonly providerEffects: WorkflowProviderEffectStore;
  readonly signals: PostgresWorkflowSignalStore;
  readonly steps: PostgresWorkflowStepStore;
  readonly undo: PostgresWorkflowUndoStore;
  readonly waits: PostgresWorkflowWaitStore;
  readonly wake: PostgresWorkflowWakeSource;

  constructor(options: PostgresWorkflowStoreOptions = {}) {
    const {
      databaseUrl = process.env.DATABASE_URL,
      definitionDeploymentScope = 'nous-reader',
      enforceCurrentDefinitions = true,
      listenClientFactory,
      logger = consoleWorkflowLogger,
      projectAssetStorage,
      sqlClient,
      workflowSetVersion = 1,
    } = options;
    if (!databaseUrl && !sqlClient) {
      throw new Error('DATABASE_URL is required for workflow storage.');
    }
    this.logger = logger;
    this.enforceCurrentDefinitions = enforceCurrentDefinitions;
    this.ownsConnection = sqlClient === undefined;
    this.sql = sqlClient ?? postgres(databaseUrl as string, { max: 10 });
    this.cancellation = new PostgresWorkflowCancellationStore(this.sql, this.logger);
    this.courseGenerationPersistence = new PostgresCourseGenerationPersistence({ sql: this.sql });
    this.definitionReconciliation = new PostgresWorkflowDefinitionReconciliationStore(
      this.sql,
      this.logger,
      definitionDeploymentScope,
      workflowSetVersion
    );
    this.outbox = new PostgresWorkflowOutboxStore(this.sql, this.logger);
    this.projectAssetDeletions = new PostgresProjectAssetDeletionQueue(this.sql);
    this.projectAssets = new PostgresProjectAssetStore(this.sql, projectAssetStorage);
    this.providerEffects = createPostgresWorkflowProviderEffectStore(this.sql);
    this.lessonGenerationPersistence = new PostgresLessonGenerationPersistence({
      assets: this.projectAssets,
      sql: this.sql,
    });
    this.lessonVisualPersistence = new PostgresLessonVisualPersistence({
      assets: this.projectAssets,
      sql: this.sql,
    });
    this.signals = new PostgresWorkflowSignalStore(
      this.sql,
      this.logger,
      this.enforceCurrentDefinitions
    );
    this.steps = new PostgresWorkflowStepStore(
      this.sql,
      this.logger,
      this.enforceCurrentDefinitions
    );
    this.undo = new PostgresWorkflowUndoStore(
      this.sql,
      this.logger,
      this.enforceCurrentDefinitions
    );
    this.waits = new PostgresWorkflowWaitStore(this.sql, this.logger);
    const createListenClient =
      listenClientFactory ??
      (() => {
        if (!databaseUrl) {
          throw new Error(
            'A database URL or listen client factory is required for workflow wakes.'
          );
        }
        return postgres(databaseUrl, { max: 1 });
      });
    this.projectRevisionInbox = new PostgresProjectRevisionInbox({
      createListenClient,
      sql: this.sql,
    });
    this.wake = new PostgresWorkflowWakeSource(createListenClient);
  }

  // fallow-ignore-next-line unused-class-member -- Called through the runtime composition store contract.
  async close(): Promise<void> {
    await this.projectRevisionInbox.stop();
    if (this.ownsConnection) await this.sql.end();
  }

  async createRun(input: CreateWorkflowRunInput): Promise<{ created: boolean; run: WorkflowRun }> {
    const requestFingerprint = workflowRequestFingerprint(input);
    const result = await this.sql.begin(async sql => {
      await lockRunIdentity(sql, input);

      const requestRun = await findRunByRequestKey(sql, input);
      if (requestRun) {
        await assertMatchingRequestFingerprint(sql, input, requestRun, requestFingerprint);
        return { created: false, run: mapRun(requestRun) };
      }

      const activeDedupeRun = await findActiveRunByDedupeKey(sql, input);
      if (activeDedupeRun) {
        await bindRunRequest(sql, input, activeDedupeRun.id, requestFingerprint);
        return { created: false, run: mapRun(activeDedupeRun) };
      }

      if (this.enforceCurrentDefinitions) await assertCurrentDefinition(sql, input);

      const status = initialRunStatus(input.materialization);
      const initialEventCount = input.materialization.durableEvents.length;
      const completed = isCompletedMaterialization(input.materialization);
      const storedOutput = completed
        ? sql.json(asPostgresJson(input.materialization.completedOutput))
        : null;
      const inserted = await sql<WorkflowRunRow[]>`
        insert into public.workflow_runs (
          id, user_id, project_id, workflow_id, definition_hash, request_key, correlation_id,
          definition_hash_version, dedupe_key, status, input, output, resolved_config,
          step_policies, step_policies_version, next_event_sequence,
          completed_at
        ) values (
          ${input.id}, ${input.userId}, ${input.projectId ?? null}, ${input.workflowId},
          ${input.definitionHash}, ${input.requestKey}, ${input.correlationId ?? createCorrelationId()}, ${input.definitionHashVersion},
          ${input.dedupeKey ?? null},
          ${status}, ${sql.json(asPostgresJson(input.input))}, ${storedOutput},
          ${sql.json(asPostgresJson(input.config))},
          ${sql.json(asPostgresJson(input.materialization.stepPolicies))},
          ${input.materialization.stepPoliciesVersion}, ${initialEventCount},
          ${completed ? sql`now()` : null}
        )
        on conflict do nothing
        returning *
      `;
      const created = inserted[0];
      if (created) {
        await bindRunRequest(sql, input, created.id, requestFingerprint);
        for (const node of input.materialization.nodes) {
          await insertMaterializedNode(sql, created.id, node);
        }
        for (const wait of input.materialization.waits) {
          await sql`
            insert into public.workflow_waits (
              id, run_id, node_instance_id, signal_type, signal_schema_version
            ) values (
              ${wait.waitId}, ${created.id}, ${wait.nodeInstanceId}, ${wait.signalType},
              ${wait.schemaVersion}
            )
          `;
        }
        await insertOutboxEvents(sql, created.id, 1n, input.materialization.durableEvents);
        if (status === 'queued') await sql`select pg_notify('workflow_ready', ${created.id})`;
        return { created: true, run: mapRun(created) };
      }

      throw new Error('Workflow run identity changed while holding its transaction lock.');
    });
    emitWorkflowLog(this.logger, {
      action: result.created ? 'created' : 'deduplicated',
      correlationId: input.correlationId,
      entity: 'run',
      run: result.run,
    });
    if (result.created) {
      for (const wait of input.materialization.waits) {
        emitWorkflowLog(this.logger, {
          action: 'created',
          entity: 'wait',
          nodeInstanceId: wait.nodeInstanceId,
          runId: result.run.id,
          signalType: wait.signalType,
          waitId: wait.waitId,
        });
      }
    }
    return result;
  }

  async getRun(input: { runId: string; userId: string }): Promise<WorkflowRun | null> {
    const rows = await this.sql<WorkflowRunRow[]>`
      select *
      from public.workflow_runs
      where id = ${input.runId} and user_id = ${input.userId}
    `;
    return rows[0] ? mapRun(rows[0]) : null;
  }

  // fallow-ignore-next-line unused-class-member -- Called through feature-specific run-reader contracts.
  async getActiveRun(input: {
    projectId: string;
    userId: string;
    workflowId: string;
  }): Promise<WorkflowRun | null> {
    const rows = await this.sql<WorkflowRunRow[]>`
      select *
      from public.workflow_runs
      where user_id = ${input.userId}
        and project_id = ${input.projectId}
        and workflow_id = ${input.workflowId}
        and status in ('queued', 'running', 'waiting')
      order by created_at desc
      limit 1
    `;
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async getRunByRequestKey(input: {
    requestKey: string;
    userId: string;
    workflowId: string;
  }): Promise<WorkflowRun | null> {
    const rows = await this.sql<WorkflowRunRow[]>`
      select run.*
      from public.workflow_run_requests request
      join public.workflow_runs run
        on run.id = request.run_id and run.user_id = request.user_id
      where request.user_id = ${input.userId}
        and request.workflow_id = ${input.workflowId}
        and request.request_key = ${input.requestKey}
      limit 1
    `;
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async getRunState(input: { runId: string; userId: string }): Promise<WorkflowRunState | null> {
    const rows = await this.sql<WorkflowRunStateRow[]>`
      select
        run.*,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'attemptCount', node.attempt_count,
                'availableAt', node.available_at,
                'completedAt', node.completed_at,
                'createdAt', node.created_at,
                'definitionId', node.node_definition_id,
                'error', node.error,
                'instanceId', node.node_instance_id,
                'itemKey', node.item_key,
                'kind', node.kind,
                'maxAttempts', node.max_attempts,
                'parentInstanceId', node.parent_instance_id,
                'status', node.status,
                'updatedAt', node.updated_at
              ) order by node.created_at, node.node_instance_id
            )
            from public.workflow_node_runs node
            where node.run_id = run.id
          ),
          '[]'::jsonb
        ) as nodes,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'createdAt', wait.created_at,
                'expiresAt', wait.expires_at,
                'nodeInstanceId', wait.node_instance_id,
                'schemaVersion', wait.signal_schema_version,
                'signalType', wait.signal_type,
                'waitId', wait.id
              ) order by wait.created_at, wait.id
            )
            from public.workflow_waits wait
            where wait.run_id = run.id and wait.status = 'waiting'
          ),
          '[]'::jsonb
        ) as waits,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'createdAt', event.created_at,
                'eventType', event.event_type,
                'payload', event.payload,
                'schemaVersion', event.schema_version,
                'sequence', event.sequence::text
              ) order by event.sequence
            )
            from public.workflow_outbox event
            where event.run_id = run.id
          ),
          '[]'::jsonb
        ) as events
      from public.workflow_runs run
      where run.id = ${input.runId} and run.user_id = ${input.userId}
    `;
    const row = rows[0];
    return row
      ? createWorkflowRunState({
          events: row.events.map(mapEventState),
          nodes: row.nodes.map(mapNodeRunState),
          run: mapRun(row),
          waits: row.waits.map(mapWaitState),
        })
      : null;
  }

  async recordAiUsage(usage: WorkflowAiUsageRecord): Promise<void> {
    await insertWorkflowAiUsage(this.sql, [usage]);
  }

  async checkpointStep(input: CheckpointWorkflowStepInput): Promise<WorkflowCheckpointResult> {
    return checkpointWorkflowStep(this.sql, input, {
      enforceCurrentDefinitions: this.enforceCurrentDefinitions,
      logger: this.logger,
    });
  }
}
