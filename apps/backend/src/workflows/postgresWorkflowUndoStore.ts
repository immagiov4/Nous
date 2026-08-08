import type { Sql, TransactionSql } from 'postgres';

import {
  asPostgresJson,
  toIsoString,
  toPostgresDefinitionBoundaryArrays,
} from './postgresWorkflowPersistence.js';
import { getRetryDecision, parseStepFailure } from './retryPolicy.js';
import type {
  StepFailure,
  WorkflowDefinitionBoundary,
  WorkflowRun,
  WorkflowStepPolicies,
} from './types.js';
import { lockAuthorizedWorkflowDefinitions } from './workflowDefinitionReconciler.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  type WorkflowLogger,
} from './workflowObservability.js';

interface UndoCandidateRow {
  attempt_count: number;
  definition_hash: string;
  definition_hash_version: number;
  input: unknown;
  max_attempts: number;
  node_definition_id: string;
  node_instance_id: string;
  output: unknown;
  step_policies: WorkflowStepPolicies;
  step_policies_version: number;
  run_id: string;
  timeout_ms: number;
  user_id: string;
  workflow_id: string;
}

interface ClaimedUndoRow {
  attempt_count: number;
  fencing_token: string;
  lease_expires_at: Date | string;
}

interface OwnedUndoRow {
  lease_valid: boolean | null;
}

interface ExpiredUndoRow {
  attempt_count: number;
  fencing_token: string;
  max_attempts: number;
  node_instance_id: string;
  run_id: string;
  worker_id: string;
}

interface RequeuedUndoRunRow {
  cleanup_status: 'pending';
  run_id: string;
  run_status: WorkflowRun['status'];
  workflow_id: string;
}

export interface WorkflowUndoClaim {
  readonly attemptNumber: number;
  readonly definitionHash: string;
  readonly definitionHashVersion: number;
  readonly fencingToken: string;
  readonly input: unknown;
  readonly leaseExpiresAt: string;
  readonly maxAttempts: number;
  readonly nodeDefinitionId: string;
  readonly nodeInstanceId: string;
  readonly output: unknown;
  readonly runId: string;
  readonly stepPolicies: WorkflowStepPolicies;
  readonly stepPoliciesVersion: number;
  readonly timeoutMs: number;
  readonly userId: string;
  readonly workerId: string;
  readonly workflowId: string;
}

export type WorkflowUndoHeartbeatResult =
  | { leaseExpiresAt: string; status: 'renewed' }
  | { status: 'lost' };

export type WorkflowUndoFailureResult =
  | { availableAt: string; delayMs: number; status: 'retrying' }
  | { status: 'failed' };

export type WorkflowUndoCompletionResult = {
  cleanupStatus: 'completed' | 'running';
};

export type ExpiredUndoRecoveryResult = {
  nodeInstanceId: string;
  outcome: 'failed' | 'retrying';
  runId: string;
};

const UNDO_LEASE_EXPIRED_FAILURE: StepFailure = {
  code: 'undo_lease_expired',
  kind: 'operational',
  message: 'The workflow undo lease expired.',
};

const assertPositiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
};

export class WorkflowUndoLeaseLostError extends Error {
  constructor() {
    super('The workflow undo lease is no longer owned by this worker.');
    this.name = 'WorkflowUndoLeaseLostError';
  }
}

const lockOwnedUndo = async (sql: TransactionSql, claim: WorkflowUndoClaim): Promise<void> => {
  const rows = await sql<OwnedUndoRow[]>`
    select lease_expires_at > clock_timestamp() as lease_valid
    from public.workflow_undo_runs
    where run_id = ${claim.runId}
      and node_instance_id = ${claim.nodeInstanceId}
      and status = 'running'
      and worker_id = ${claim.workerId}
      and fencing_token = ${claim.fencingToken}
    for update
  `;
  if (!rows[0]?.lease_valid) throw new WorkflowUndoLeaseLostError();
};

const lockActiveWorkflowCleanup = async (sql: TransactionSql, runId: string): Promise<void> => {
  const rows = await sql`
    select 1
    from public.workflow_runs
    where id = ${runId} and cleanup_status in ('pending', 'running')
    for update
  `;
  if (rows.length !== 1) throw new WorkflowUndoLeaseLostError();
};

const finishAttempt = async (
  sql: TransactionSql,
  input: {
    claim: WorkflowUndoClaim;
    failure?: StepFailure;
    status: 'completed' | 'failed';
  }
): Promise<void> => {
  const rows = await sql`
    update public.workflow_undo_attempts
    set status = ${input.status},
        error = ${input.failure ? sql.json(asPostgresJson(input.failure)) : null},
        finished_at = clock_timestamp()
    where run_id = ${input.claim.runId}
      and node_instance_id = ${input.claim.nodeInstanceId}
      and attempt_number = ${input.claim.attemptNumber}
      and fencing_token = ${input.claim.fencingToken}
      and status = 'running'
    returning 1
  `;
  if (rows.length !== 1) throw new Error('Running workflow undo attempt is missing.');
};

const markWorkflowCleanupFailed = async (sql: TransactionSql, runId: string): Promise<void> => {
  const rows = await sql`
    update public.workflow_runs
    set cleanup_status = 'failed',
        updated_at = clock_timestamp(),
        version = version + 1
    where id = ${runId} and cleanup_status in ('pending', 'running')
    returning 1
  `;
  if (rows.length !== 1) throw new Error(`Workflow run ${runId} cleanup could not be failed.`);
};

export class PostgresWorkflowUndoStore {
  constructor(
    private readonly sql: Sql,
    private readonly logger: WorkflowLogger = consoleWorkflowLogger,
    private readonly enforceCurrentDefinitions = false
  ) {}

  // A restart grants exhausted cleanup one fresh attempt without rewriting its failure history.
  async requeueFailed(input: {
    supportedDefinitions: readonly WorkflowDefinitionBoundary[];
  }): Promise<number> {
    if (input.supportedDefinitions.length === 0) return 0;
    const runs = await this.sql.begin(async (sql): Promise<RequeuedUndoRunRow[]> => {
      const authorizedDefinitions = this.enforceCurrentDefinitions
        ? await lockAuthorizedWorkflowDefinitions(sql, input.supportedDefinitions)
        : input.supportedDefinitions;
      if (authorizedDefinitions.length === 0) return [];
      const supportedDefinitions = toPostgresDefinitionBoundaryArrays(authorizedDefinitions);
      return sql<RequeuedUndoRunRow[]>`
      with failed_undo as (
        select undo.run_id, undo.node_instance_id
        from public.workflow_undo_runs undo
        join public.workflow_runs run on run.id = undo.run_id
        where undo.status = 'failed'
          and undo.error->>'kind' in ('operational', 'corrective')
          and run.status in ('failed', 'cancelled', 'expired')
          and run.cleanup_status = 'failed'
          and exists (
            select 1
            from unnest(
              ${sql.array(supportedDefinitions.workflowIds)}::text[],
              ${sql.array(supportedDefinitions.definitionHashes)}::text[],
              ${sql.array(supportedDefinitions.definitionHashVersions)}::integer[]
            ) as supported(workflow_id, definition_hash, definition_hash_version)
            where supported.workflow_id = run.workflow_id
              and supported.definition_hash = run.definition_hash
              and supported.definition_hash_version = run.definition_hash_version
          )
        for update of undo, run skip locked
      ), requeued_undo as (
        update public.workflow_undo_runs undo
        set status = 'retrying',
            available_at = clock_timestamp(),
            max_attempts = greatest(undo.max_attempts, undo.attempt_count + 1),
            updated_at = clock_timestamp()
        from failed_undo
        where undo.run_id = failed_undo.run_id
          and undo.node_instance_id = failed_undo.node_instance_id
          and undo.status = 'failed'
        returning undo.run_id
      ), reopened_runs as (
        update public.workflow_runs run
        set cleanup_status = 'pending',
            updated_at = clock_timestamp(),
            version = version + 1
        where run.cleanup_status = 'failed'
          and exists (
            select 1 from requeued_undo requeued where requeued.run_id = run.id
          )
        returning run.id, run.status, run.workflow_id
      )
      select
        id as run_id,
        workflow_id,
        status as run_status,
        'pending'::text as cleanup_status
      from reopened_runs
      `;
    });
    for (const run of runs) {
      emitWorkflowLog(this.logger, {
        action: 'reconciled',
        cleanupStatus: run.cleanup_status,
        entity: 'run',
        runId: run.run_id,
        runStatus: run.run_status,
        workflowId: run.workflow_id,
      });
    }
    return runs.length;
  }

  async claimNext(input: {
    leaseMs: number;
    supportedDefinitions: readonly WorkflowDefinitionBoundary[];
    workerId: string;
  }): Promise<WorkflowUndoClaim | null> {
    assertPositiveInteger(input.leaseMs, 'leaseMs');
    if (!input.workerId.trim()) throw new Error('workerId is required.');
    if (input.supportedDefinitions.length === 0) return null;

    const claim = await this.sql.begin(async sql => {
      const authorizedDefinitions = this.enforceCurrentDefinitions
        ? await lockAuthorizedWorkflowDefinitions(sql, input.supportedDefinitions)
        : input.supportedDefinitions;
      if (authorizedDefinitions.length === 0) return null;
      const supportedDefinitions = toPostgresDefinitionBoundaryArrays(authorizedDefinitions);
      const candidates = await sql<UndoCandidateRow[]>`
        select
          undo.run_id,
          undo.node_instance_id,
          undo.input,
          undo.output,
          undo.attempt_count,
          undo.max_attempts,
          undo.timeout_ms,
          node.node_definition_id,
          run.workflow_id,
          run.definition_hash,
          run.definition_hash_version,
          run.step_policies,
          run.step_policies_version,
          run.user_id
        from public.workflow_undo_runs undo
        join public.workflow_runs run on run.id = undo.run_id
        join public.workflow_node_runs node
          on node.run_id = undo.run_id and node.node_instance_id = undo.node_instance_id
        where undo.status in ('queued', 'retrying')
          and undo.available_at <= clock_timestamp()
          and undo.attempt_count < undo.max_attempts
          and run.status in ('failed', 'cancelled', 'expired')
          and run.cleanup_status in ('pending', 'running')
          and exists (
            select 1
            from unnest(
              ${sql.array(supportedDefinitions.workflowIds)}::text[],
              ${sql.array(supportedDefinitions.definitionHashes)}::text[],
              ${sql.array(supportedDefinitions.definitionHashVersions)}::integer[]
            ) as supported(workflow_id, definition_hash, definition_hash_version)
            where supported.workflow_id = run.workflow_id
              and supported.definition_hash = run.definition_hash
              and supported.definition_hash_version = run.definition_hash_version
          )
          and not exists (
            select 1
            from public.workflow_undo_runs preceding
            where preceding.run_id = undo.run_id
              and preceding.status <> 'completed'
              and (preceding.reverse_order, preceding.node_instance_id)
                < (undo.reverse_order, undo.node_instance_id)
          )
        order by undo.available_at, undo.created_at, undo.run_id,
                 undo.reverse_order, undo.node_instance_id
        for update of undo skip locked
        limit 1
      `;
      const candidate = candidates[0];
      if (!candidate) return null;
      await lockActiveWorkflowCleanup(sql, candidate.run_id);

      const claimedRows = await sql<ClaimedUndoRow[]>`
        update public.workflow_undo_runs
        set status = 'running',
            worker_id = ${input.workerId},
            lease_expires_at = clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
            fencing_token = fencing_token + 1,
            attempt_count = attempt_count + 1,
            updated_at = clock_timestamp()
        where run_id = ${candidate.run_id}
          and node_instance_id = ${candidate.node_instance_id}
          and status in ('queued', 'retrying')
          and attempt_count < max_attempts
        returning attempt_count, fencing_token::text, lease_expires_at
      `;
      const claimed = claimedRows[0];
      if (!claimed) throw new Error('Eligible workflow undo could not be claimed.');

      await sql`
        insert into public.workflow_undo_attempts (
          run_id, node_instance_id, attempt_number, fencing_token, worker_id
        ) values (
          ${candidate.run_id}, ${candidate.node_instance_id}, ${claimed.attempt_count},
          ${claimed.fencing_token}, ${input.workerId}
        )
      `;
      await sql`
        update public.workflow_runs
        set cleanup_status = 'running',
            updated_at = clock_timestamp(),
            version = version + 1
        where id = ${candidate.run_id} and cleanup_status = 'pending'
      `;

      return {
        attemptNumber: claimed.attempt_count,
        definitionHash: candidate.definition_hash,
        definitionHashVersion: candidate.definition_hash_version,
        fencingToken: claimed.fencing_token,
        input: candidate.input,
        leaseExpiresAt: toIsoString(claimed.lease_expires_at),
        maxAttempts: candidate.max_attempts,
        nodeDefinitionId: candidate.node_definition_id,
        nodeInstanceId: candidate.node_instance_id,
        output: candidate.output,
        runId: candidate.run_id,
        stepPolicies: candidate.step_policies,
        stepPoliciesVersion: candidate.step_policies_version,
        timeoutMs: candidate.timeout_ms,
        userId: candidate.user_id,
        workerId: input.workerId,
        workflowId: candidate.workflow_id,
      };
    });
    if (claim) {
      emitWorkflowLog(this.logger, {
        action: 'claimed',
        claim,
        entity: 'attempt',
        operation: 'undo',
        outcome: 'running',
      });
    }
    return claim;
  }

  async heartbeat(input: {
    claim: WorkflowUndoClaim;
    leaseMs: number;
  }): Promise<WorkflowUndoHeartbeatResult> {
    assertPositiveInteger(input.leaseMs, 'leaseMs');
    const result = await this.sql.begin(async sql => {
      if (this.enforceCurrentDefinitions) {
        const authorized = await lockAuthorizedWorkflowDefinitions(sql, [
          {
            definitionHash: input.claim.definitionHash,
            definitionHashVersion: input.claim.definitionHashVersion,
            workflowId: input.claim.workflowId,
          },
        ]);
        if (authorized.length !== 1) return { status: 'lost' as const };
      }
      const rows = await sql<Array<{ lease_expires_at: Date | string }>>`
        update public.workflow_undo_runs undo
        set lease_expires_at = clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
            updated_at = clock_timestamp()
        from public.workflow_runs run
        where undo.run_id = ${input.claim.runId}
          and undo.node_instance_id = ${input.claim.nodeInstanceId}
          and undo.status = 'running'
          and undo.worker_id = ${input.claim.workerId}
          and undo.fencing_token = ${input.claim.fencingToken}
          and undo.lease_expires_at > clock_timestamp()
          and run.id = undo.run_id
          and run.cleanup_status = 'running'
        returning undo.lease_expires_at
      `;
      const undo = rows[0];
      return undo
        ? { leaseExpiresAt: toIsoString(undo.lease_expires_at), status: 'renewed' as const }
        : { status: 'lost' as const };
    });
    if (result.status !== 'renewed') {
      emitWorkflowLog(this.logger, {
        action: 'lease-lost',
        claim: input.claim,
        entity: 'attempt',
        operation: 'undo',
      });
    }
    return result;
  }

  async complete(claim: WorkflowUndoClaim): Promise<WorkflowUndoCompletionResult> {
    const result = await this.sql.begin(async sql => {
      if (this.enforceCurrentDefinitions) {
        const authorized = await lockAuthorizedWorkflowDefinitions(sql, [
          {
            definitionHash: claim.definitionHash,
            definitionHashVersion: claim.definitionHashVersion,
            workflowId: claim.workflowId,
          },
        ]);
        if (authorized.length !== 1) throw new WorkflowUndoLeaseLostError();
      }
      await lockOwnedUndo(sql, claim);
      await lockActiveWorkflowCleanup(sql, claim.runId);
      await finishAttempt(sql, { claim, status: 'completed' });

      const undoRows = await sql`
        update public.workflow_undo_runs
        set status = 'completed',
            error = null,
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
      if (undoRows.length !== 1) throw new WorkflowUndoLeaseLostError();

      const remaining = await sql`
        select 1
        from public.workflow_undo_runs
        where run_id = ${claim.runId} and status <> 'completed'
        limit 1
      `;
      const cleanupStatus: WorkflowUndoCompletionResult['cleanupStatus'] =
        remaining.length === 0 ? 'completed' : 'running';
      await sql`
        update public.workflow_runs
        set cleanup_status = ${cleanupStatus},
            updated_at = clock_timestamp(),
            version = version + 1
        where id = ${claim.runId}
      `;
      if (cleanupStatus === 'running') {
        await sql`select pg_notify('workflow_undo_ready', ${claim.runId})`;
      }
      return { cleanupStatus };
    });
    emitWorkflowLog(this.logger, {
      action: 'completed',
      claim,
      cleanupStatus: result.cleanupStatus,
      entity: 'attempt',
      operation: 'undo',
      outcome: 'completed',
    });
    return result;
  }

  async recordFailure(input: {
    claim: WorkflowUndoClaim;
    failure: StepFailure;
    random?: () => number;
  }): Promise<WorkflowUndoFailureResult> {
    const failure = parseStepFailure(input.failure);
    const decision = getRetryDecision({
      attemptNumber: input.claim.attemptNumber,
      failure,
      maxAttempts: input.claim.maxAttempts,
      ...(input.random ? { random: input.random } : {}),
    });

    const result = await this.sql.begin(async sql => {
      if (this.enforceCurrentDefinitions) {
        const authorized = await lockAuthorizedWorkflowDefinitions(sql, [
          {
            definitionHash: input.claim.definitionHash,
            definitionHashVersion: input.claim.definitionHashVersion,
            workflowId: input.claim.workflowId,
          },
        ]);
        if (authorized.length !== 1) throw new WorkflowUndoLeaseLostError();
      }
      await lockOwnedUndo(sql, input.claim);
      await lockActiveWorkflowCleanup(sql, input.claim.runId);
      await finishAttempt(sql, { claim: input.claim, failure, status: 'failed' });

      if (!decision.retry) {
        const rows = await sql`
          update public.workflow_undo_runs
          set status = 'failed',
              error = ${sql.json(asPostgresJson(failure))},
              worker_id = null,
              lease_expires_at = null,
              updated_at = clock_timestamp()
          where run_id = ${input.claim.runId}
            and node_instance_id = ${input.claim.nodeInstanceId}
            and status = 'running'
            and worker_id = ${input.claim.workerId}
            and fencing_token = ${input.claim.fencingToken}
            and lease_expires_at > clock_timestamp()
          returning 1
        `;
        if (rows.length !== 1) throw new WorkflowUndoLeaseLostError();
        await markWorkflowCleanupFailed(sql, input.claim.runId);
        return { status: 'failed' as const };
      }

      const rows = await sql<Array<{ available_at: Date | string }>>`
        update public.workflow_undo_runs
        set status = 'retrying',
            error = ${sql.json(asPostgresJson(failure))},
            available_at = clock_timestamp() + (${decision.delayMs} * interval '1 millisecond'),
            worker_id = null,
            lease_expires_at = null,
            updated_at = clock_timestamp()
        where run_id = ${input.claim.runId}
          and node_instance_id = ${input.claim.nodeInstanceId}
          and status = 'running'
          and worker_id = ${input.claim.workerId}
          and fencing_token = ${input.claim.fencingToken}
          and lease_expires_at > clock_timestamp()
        returning available_at
      `;
      const undo = rows[0];
      if (!undo) throw new WorkflowUndoLeaseLostError();
      await sql`
        update public.workflow_runs
        set updated_at = clock_timestamp(), version = version + 1
        where id = ${input.claim.runId}
      `;
      await sql`select pg_notify('workflow_undo_ready', ${input.claim.runId})`;
      return {
        availableAt: toIsoString(undo.available_at),
        delayMs: decision.delayMs,
        status: 'retrying' as const,
      };
    });
    emitWorkflowLog(this.logger, {
      action: result.status === 'retrying' ? 'retry-scheduled' : 'failed',
      ...(result.status === 'retrying'
        ? { availableAt: result.availableAt, retryDelayMs: result.delayMs }
        : {}),
      claim: input.claim,
      ...(result.status === 'failed' ? { cleanupStatus: 'failed' as const } : {}),
      entity: 'attempt',
      failure,
      operation: 'undo',
      outcome: result.status,
    });
    return result;
  }

  async recoverNextExpired(input: {
    random?: () => number;
    supportedDefinitions: readonly WorkflowDefinitionBoundary[];
  }): Promise<ExpiredUndoRecoveryResult | null> {
    if (input.supportedDefinitions.length === 0) return null;
    const recovered = await this.sql.begin(async sql => {
      const authorizedDefinitions = this.enforceCurrentDefinitions
        ? await lockAuthorizedWorkflowDefinitions(sql, input.supportedDefinitions)
        : input.supportedDefinitions;
      if (authorizedDefinitions.length === 0) return null;
      const supportedDefinitions = toPostgresDefinitionBoundaryArrays(authorizedDefinitions);
      const candidates = await sql<ExpiredUndoRow[]>`
        select
          undo.run_id,
          undo.node_instance_id,
          undo.attempt_count,
          undo.max_attempts,
          undo.fencing_token::text,
          undo.worker_id
        from public.workflow_undo_runs undo
        join public.workflow_runs run on run.id = undo.run_id
        where undo.status = 'running'
          and undo.lease_expires_at <= clock_timestamp()
          and run.status in ('failed', 'cancelled', 'expired')
          and run.cleanup_status = 'running'
          and exists (
            select 1
            from unnest(
              ${sql.array(supportedDefinitions.workflowIds)}::text[],
              ${sql.array(supportedDefinitions.definitionHashes)}::text[],
              ${sql.array(supportedDefinitions.definitionHashVersions)}::integer[]
            ) as supported(workflow_id, definition_hash, definition_hash_version)
            where supported.workflow_id = run.workflow_id
              and supported.definition_hash = run.definition_hash
              and supported.definition_hash_version = run.definition_hash_version
          )
        order by undo.lease_expires_at, undo.run_id, undo.node_instance_id
        for update of undo skip locked
        limit 1
      `;
      const candidate = candidates[0];
      if (!candidate) return null;

      await lockActiveWorkflowCleanup(sql, candidate.run_id);
      const attempts = await sql`
        update public.workflow_undo_attempts
        set status = 'lost',
            error = ${sql.json(asPostgresJson(UNDO_LEASE_EXPIRED_FAILURE))},
            finished_at = clock_timestamp()
        where run_id = ${candidate.run_id}
          and node_instance_id = ${candidate.node_instance_id}
          and attempt_number = ${candidate.attempt_count}
          and fencing_token = ${candidate.fencing_token}
          and status = 'running'
        returning 1
      `;
      if (attempts.length !== 1) throw new Error('Expired workflow undo attempt is missing.');

      const decision = getRetryDecision({
        attemptNumber: candidate.attempt_count,
        failure: UNDO_LEASE_EXPIRED_FAILURE,
        maxAttempts: candidate.max_attempts,
        ...(input.random ? { random: input.random } : {}),
      });
      if (!decision.retry) {
        const failed = await sql`
          update public.workflow_undo_runs
          set status = 'failed',
              error = ${sql.json(asPostgresJson(UNDO_LEASE_EXPIRED_FAILURE))},
              worker_id = null,
              lease_expires_at = null,
              fencing_token = fencing_token + 1,
              updated_at = clock_timestamp()
          where run_id = ${candidate.run_id}
            and node_instance_id = ${candidate.node_instance_id}
            and status = 'running'
            and worker_id = ${candidate.worker_id}
            and fencing_token = ${candidate.fencing_token}
          returning 1
        `;
        if (failed.length !== 1) throw new WorkflowUndoLeaseLostError();
        await markWorkflowCleanupFailed(sql, candidate.run_id);
        return {
          attemptNumber: candidate.attempt_count,
          fencingToken: candidate.fencing_token,
          result: {
            nodeInstanceId: candidate.node_instance_id,
            outcome: 'failed' as const,
            runId: candidate.run_id,
          },
          workerId: candidate.worker_id,
        };
      }

      const retried = await sql`
        update public.workflow_undo_runs
        set status = 'retrying',
            error = ${sql.json(asPostgresJson(UNDO_LEASE_EXPIRED_FAILURE))},
            available_at = clock_timestamp() + (${decision.delayMs} * interval '1 millisecond'),
            worker_id = null,
            lease_expires_at = null,
            fencing_token = fencing_token + 1,
            updated_at = clock_timestamp()
        where run_id = ${candidate.run_id}
          and node_instance_id = ${candidate.node_instance_id}
          and status = 'running'
          and worker_id = ${candidate.worker_id}
          and fencing_token = ${candidate.fencing_token}
        returning 1
      `;
      if (retried.length !== 1) throw new WorkflowUndoLeaseLostError();
      await sql`
        update public.workflow_runs
        set updated_at = clock_timestamp(), version = version + 1
        where id = ${candidate.run_id}
      `;
      await sql`select pg_notify('workflow_undo_ready', ${candidate.run_id})`;
      return {
        attemptNumber: candidate.attempt_count,
        fencingToken: candidate.fencing_token,
        result: {
          nodeInstanceId: candidate.node_instance_id,
          outcome: 'retrying' as const,
          runId: candidate.run_id,
        },
        workerId: candidate.worker_id,
      };
    });
    if (!recovered) return null;
    emitWorkflowLog(this.logger, {
      action: 'recovered',
      claim: {
        attemptNumber: recovered.attemptNumber,
        fencingToken: recovered.fencingToken,
        nodeInstanceId: recovered.result.nodeInstanceId,
        runId: recovered.result.runId,
        workerId: recovered.workerId,
      },
      ...(recovered.result.outcome === 'failed' ? { cleanupStatus: 'failed' as const } : {}),
      entity: 'attempt',
      failure: UNDO_LEASE_EXPIRED_FAILURE,
      operation: 'undo',
      outcome: recovered.result.outcome,
    });
    return recovered.result;
  }
}
