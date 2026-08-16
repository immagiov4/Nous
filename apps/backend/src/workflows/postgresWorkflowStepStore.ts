import type { Sql, TransactionSql } from 'postgres';
import type { MaterializedWorkflowEvent } from './materialization.js';
import {
  failExpiredWorkflowStep,
  failWorkflowForMissingDefinition,
  failWorkflowStep,
} from './postgresWorkflowCheckpoint.js';
import { lockOwnedWorkflowClaim } from './postgresWorkflowOwnership.js';
import {
  asPostgresJson,
  insertWorkflowAiUsage,
  toIsoString,
  toPostgresDefinitionBoundaryArrays,
} from './postgresWorkflowPersistence.js';
import { getRetryDecision, parseStepFailure } from './retryPolicy.js';
import type {
  ErasedRegisteredWorkflow,
  RegisteredWorkflow,
  StepFailure,
  WorkflowDefinitionBoundary,
  WorkflowNodeKind,
  WorkflowStepClaim,
  WorkflowStepPolicies,
} from './types.js';
import type { WorkflowAiUsageRecord } from './workflowAiMetering.js';
import { lockAuthorizedWorkflowDefinitions } from './workflowDefinitionReconciler.js';
import { WorkflowLeaseLostError } from './workflowErrors.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  type WorkflowLogger,
} from './workflowObservability.js';

interface ClaimCandidateRow {
  attempt_count: number;
  correlation_id: string;
  definition_hash: string;
  definition_hash_version: number;
  input: unknown;
  kind: WorkflowNodeKind;
  max_attempts: number;
  node_definition_id: string;
  node_instance_id: string;
  previous_error: unknown;
  run_id: string;
  step_policies: WorkflowStepPolicies;
  step_policies_version: number;
  timeout_ms: number;
  user_id: string;
  workflow_id: string;
}

interface ClaimedNodeRow {
  attempt_count: number;
  fencing_token: string;
  lease_expires_at: Date | string;
}

interface HeartbeatRow {
  cancellation_requested: boolean;
  lease_expires_at: Date | string | null;
}

interface ClaimRunRow {
  cancellation_requested: boolean;
  status: 'queued' | 'running';
}

interface ExpiredStepRow {
  attempt_count: number;
  correlation_id: string;
  definition_hash: string;
  definition_hash_version: number;
  fencing_token: string;
  max_attempts: number;
  node_definition_id: string;
  node_instance_id: string;
  run_id: string;
  step_policies: WorkflowStepPolicies;
  step_policies_version: number;
  worker_id: string;
  workflow_id: string;
}

export type WorkflowHeartbeatResult =
  | { leaseExpiresAt: string; status: 'renewed' }
  | { status: 'cancelled' }
  | { status: 'lost' };

export type WorkflowStepFailureResult =
  | { availableAt: string; delayMs: number; status: 'retrying' }
  | { status: 'failed'; transientEvents: readonly MaterializedWorkflowEvent[] };

export type ExpiredStepRecoveryResult = {
  nodeInstanceId: string;
  outcome: 'cancelled' | 'completed' | 'continued' | 'failed' | 'retrying';
  runId: string;
  transientEvents?: readonly MaterializedWorkflowEvent[];
  workflowId?: string;
};

interface ExpiredStepRecoveryLogResult {
  claim: {
    attemptNumber: number;
    fencingToken: string;
    nodeDefinitionId: string;
    nodeInstanceId: string;
    runId: string;
    workerId: string;
    workflowId: string;
  };
  failure: StepFailure;
  result: ExpiredStepRecoveryResult;
  retryDelayMs?: number;
}

const LEASE_EXPIRED_FAILURE: StepFailure = {
  code: 'worker_lease_expired',
  kind: 'operational',
  message: 'The workflow worker lease expired.',
};

const MISSING_WORKFLOW_DEFINITION_FAILURE: StepFailure = {
  code: 'workflow_definition_unavailable',
  kind: 'permanent',
  message: 'The workflow definition required to resume this run is unavailable.',
};

const previousFailure = (value: unknown): StepFailure | undefined =>
  value === null || value === undefined ? undefined : parseStepFailure(value);

const retryFeedback = (failure: StepFailure | undefined): string =>
  failure?.kind === 'corrective' ? failure.feedback : '';

const markExpiredWorkflowAttemptLost = async (
  sql: TransactionSql,
  candidate: ExpiredStepRow
): Promise<void> => {
  const attemptRows = await sql`
    update public.workflow_node_attempts
    set status = 'lost',
        error = ${sql.json(asPostgresJson(LEASE_EXPIRED_FAILURE))},
        finished_at = clock_timestamp()
    where run_id = ${candidate.run_id}
      and node_instance_id = ${candidate.node_instance_id}
      and attempt_number = ${candidate.attempt_count}
      and fencing_token = ${candidate.fencing_token}
      and status = 'running'
    returning 1
  `;
  if (attemptRows.length !== 1) throw new Error('Expired workflow attempt is missing.');
};

const cancelExpiredWorkflowStep = async (
  sql: TransactionSql,
  candidate: ExpiredStepRow,
  claim: ExpiredStepRecoveryLogResult['claim']
): Promise<ExpiredStepRecoveryLogResult> => {
  const nodeRows = await sql`
    update public.workflow_node_runs
    set status = 'cancelled',
        error = ${sql.json(asPostgresJson(LEASE_EXPIRED_FAILURE))},
        worker_id = null,
        lease_expires_at = null,
        fencing_token = fencing_token + 1,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where run_id = ${candidate.run_id}
      and node_instance_id = ${candidate.node_instance_id}
    returning 1
  `;
  if (nodeRows.length !== 1) throw new Error('Expired workflow step could not be cancelled.');
  return {
    claim,
    failure: LEASE_EXPIRED_FAILURE,
    result: {
      nodeInstanceId: candidate.node_instance_id,
      outcome: 'cancelled',
      runId: candidate.run_id,
    },
  };
};

export class PostgresWorkflowStepStore {
  constructor(
    private readonly sql: Sql,
    private readonly logger: WorkflowLogger = consoleWorkflowLogger,
    private readonly enforceCurrentDefinitions = false
  ) {}

  async recordDefinitionUnavailable(input: {
    claim: WorkflowStepClaim;
    failure: StepFailure;
  }): Promise<void> {
    const failure = parseStepFailure(input.failure);
    if (failure.kind !== 'permanent') {
      throw new Error('An unavailable workflow definition must be a permanent failure.');
    }
    await this.sql.begin(async sql => {
      await lockOwnedWorkflowClaim(sql, input.claim);
      await failWorkflowForMissingDefinition(sql, {
        attemptNumber: input.claim.attemptNumber,
        failure,
        fencingToken: input.claim.fencingToken,
        nodeInstanceId: input.claim.nodeInstanceId,
        runId: input.claim.runId,
        workerId: input.claim.workerId,
      });
    });
    emitWorkflowLog(this.logger, {
      action: 'failed',
      claim: input.claim,
      entity: 'attempt',
      failure,
      operation: 'step',
      outcome: 'failed',
    });
    emitWorkflowLog(this.logger, {
      action: 'definition-unavailable',
      entity: 'run',
      failure,
      runId: input.claim.runId,
      runStatus: 'failed',
      workflowId: input.claim.workflowId,
    });
  }

  async claimNext(input: {
    leaseMs: number;
    supportedDefinitions: readonly WorkflowDefinitionBoundary[];
    workerId: string;
  }): Promise<WorkflowStepClaim | null> {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new Error('leaseMs must be a positive integer.');
    }
    if (!input.workerId.trim()) throw new Error('workerId is required.');
    if (input.supportedDefinitions.length === 0) return null;

    const claim = await this.sql.begin(async sql => {
      const authorizedDefinitions = this.enforceCurrentDefinitions
        ? await lockAuthorizedWorkflowDefinitions(sql, input.supportedDefinitions)
        : input.supportedDefinitions;
      if (authorizedDefinitions.length === 0) return null;
      const supportedDefinitions = toPostgresDefinitionBoundaryArrays(authorizedDefinitions);
      const candidates = await sql<ClaimCandidateRow[]>`
        select
          node.run_id,
          node.node_instance_id,
          node.node_definition_id,
          node.kind,
          node.max_attempts,
          node.timeout_ms,
          node.input,
          node.error as previous_error,
          node.attempt_count,
          run.workflow_id,
          run.correlation_id,
          run.definition_hash,
          run.definition_hash_version,
          run.step_policies,
          run.step_policies_version,
          run.user_id
        from public.workflow_node_runs node
        join public.workflow_runs run on run.id = node.run_id
        where node.status in ('queued', 'retrying')
          and node.available_at <= clock_timestamp()
          and node.attempt_count < node.max_attempts
          and run.status in ('queued', 'running')
          and not run.cancellation_requested
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
        order by node.available_at, node.created_at, node.run_id, node.node_instance_id
        for update of node skip locked
        limit 1
      `;
      const candidate = candidates[0];
      if (!candidate) return null;

      const runRows = await sql<ClaimRunRow[]>`
        select status, cancellation_requested
        from public.workflow_runs
        where id = ${candidate.run_id} and status in ('queued', 'running')
        for update
      `;
      const run = runRows[0];
      if (!run || run.cancellation_requested) return null;

      const claimed = await sql<ClaimedNodeRow[]>`
        update public.workflow_node_runs node
        set status = 'running',
            worker_id = ${input.workerId},
            lease_expires_at = clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
            fencing_token = fencing_token + 1,
            attempt_count = attempt_count + 1,
            updated_at = clock_timestamp()
        from public.workflow_runs run
        where node.run_id = ${candidate.run_id}
          and node.node_instance_id = ${candidate.node_instance_id}
          and node.status in ('queued', 'retrying')
          and node.attempt_count < node.max_attempts
          and run.id = node.run_id
          and run.status in ('queued', 'running')
          and not run.cancellation_requested
        returning node.attempt_count, node.fencing_token::text, node.lease_expires_at
      `;
      const node = claimed[0];
      if (!node) throw new Error('Eligible workflow step could not be claimed.');

      await sql`
        insert into public.workflow_node_attempts (
          run_id, node_instance_id, attempt_number, fencing_token, worker_id
        ) values (
          ${candidate.run_id}, ${candidate.node_instance_id}, ${node.attempt_count},
          ${node.fencing_token}, ${input.workerId}
        )
      `;
      await sql`
        update public.workflow_runs
        set status = 'running',
            started_at = coalesce(started_at, clock_timestamp()),
            updated_at = clock_timestamp(),
            version = version + 1
        where id = ${candidate.run_id} and status = 'queued'
      `;

      const failure = previousFailure(candidate.previous_error);
      return {
        attemptNumber: node.attempt_count,
        definitionHash: candidate.definition_hash,
        definitionHashVersion: candidate.definition_hash_version,
        fencingToken: node.fencing_token,
        input: candidate.input,
        kind: candidate.kind,
        leaseExpiresAt: toIsoString(node.lease_expires_at),
        maxAttempts: candidate.max_attempts,
        nodeDefinitionId: candidate.node_definition_id,
        nodeInstanceId: candidate.node_instance_id,
        ...(failure ? { previousAttemptFailure: failure } : {}),
        retryFeedback: retryFeedback(failure),
        correlationId: candidate.correlation_id,
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
        operation: 'step',
        outcome: 'running',
      });
    }
    return claim;
  }

  async heartbeat(input: {
    claim: WorkflowStepClaim;
    leaseMs: number;
  }): Promise<WorkflowHeartbeatResult> {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new Error('leaseMs must be a positive integer.');
    }
    return this.sql.begin(async sql => {
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
      const rows = await sql<HeartbeatRow[]>`
        with renewed as (
          update public.workflow_node_runs node
          set lease_expires_at = clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
              updated_at = clock_timestamp()
          from public.workflow_runs run
          where node.run_id = ${input.claim.runId}
            and node.node_instance_id = ${input.claim.nodeInstanceId}
            and node.status = 'running'
            and node.worker_id = ${input.claim.workerId}
            and node.fencing_token = ${input.claim.fencingToken}
            and node.lease_expires_at > clock_timestamp()
            and run.id = node.run_id
            and not run.cancellation_requested
          returning node.lease_expires_at
        )
        select run.cancellation_requested, renewed.lease_expires_at
        from public.workflow_runs run
        left join renewed on true
        where run.id = ${input.claim.runId}
      `;
      const heartbeat = rows[0];
      if (heartbeat?.lease_expires_at) {
        return { leaseExpiresAt: toIsoString(heartbeat.lease_expires_at), status: 'renewed' };
      }
      return heartbeat?.cancellation_requested
        ? { status: 'cancelled' as const }
        : { status: 'lost' as const };
    });
  }

  async recordFailure(input: {
    aiUsage?: readonly WorkflowAiUsageRecord[];
    claim: WorkflowStepClaim;
    definition: ErasedRegisteredWorkflow;
    failure: StepFailure;
    random?: () => number;
  }): Promise<WorkflowStepFailureResult> {
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
        if (authorized.length !== 1) throw new WorkflowLeaseLostError();
      }
      await lockOwnedWorkflowClaim(sql, input.claim);
      await insertWorkflowAiUsage(sql, input.aiUsage ?? []);
      if (!decision.retry) {
        const transientEvents = await failWorkflowStep(sql, {
          claim: input.claim,
          definition: input.definition,
          failure,
        });
        return { status: 'failed' as const, transientEvents };
      }

      const attemptRows = await sql`
        update public.workflow_node_attempts
        set status = 'failed',
            error = ${sql.json(asPostgresJson(failure))},
            finished_at = clock_timestamp()
        where run_id = ${input.claim.runId}
          and node_instance_id = ${input.claim.nodeInstanceId}
          and attempt_number = ${input.claim.attemptNumber}
          and fencing_token = ${input.claim.fencingToken}
          and status = 'running'
        returning 1
      `;
      if (attemptRows.length !== 1) throw new Error('Running workflow attempt is missing.');

      const nodeRows = await sql<Array<{ available_at: Date | string }>>`
        update public.workflow_node_runs
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
        returning available_at
      `;
      const node = nodeRows[0];
      if (!node) throw new Error('Owned workflow step could not be scheduled for retry.');
      await sql`
        update public.workflow_runs
        set updated_at = clock_timestamp(), version = version + 1
        where id = ${input.claim.runId}
      `;
      await sql`select pg_notify('workflow_ready', ${input.claim.runId})`;
      return {
        availableAt: toIsoString(node.available_at),
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
      entity: 'attempt',
      failure,
      operation: 'step',
      outcome: result.status,
    });
    return result;
  }

  async recoverNextExpired(input: {
    random?: () => number;
    resolveDefinition: (
      workflowId: string,
      definitionHash: string,
      definitionHashVersion: number
    ) => RegisteredWorkflow | null;
    supportedDefinitions: readonly WorkflowDefinitionBoundary[];
  }): Promise<ExpiredStepRecoveryResult | null> {
    if (input.supportedDefinitions.length === 0) return null;
    const recovery = await this.sql.begin(async (sql: TransactionSql) => {
      const authorizedDefinitions = this.enforceCurrentDefinitions
        ? await lockAuthorizedWorkflowDefinitions(sql, input.supportedDefinitions)
        : input.supportedDefinitions;
      if (authorizedDefinitions.length === 0) return null;
      const supportedDefinitions = toPostgresDefinitionBoundaryArrays(authorizedDefinitions);
      const candidates = await sql<ExpiredStepRow[]>`
        select
          node.run_id,
          node.node_instance_id,
          node.node_definition_id,
          node.attempt_count,
          node.max_attempts,
          node.fencing_token::text,
          node.worker_id,
          run.workflow_id,
          run.correlation_id,
          run.definition_hash,
          run.definition_hash_version,
          run.step_policies,
          run.step_policies_version
        from public.workflow_node_runs node
        join public.workflow_runs run on run.id = node.run_id
        where node.status = 'running'
          and node.lease_expires_at <= clock_timestamp()
          and (
            run.status in ('queued', 'running')
            or (run.cancellation_requested and run.status in ('cancelled', 'failed', 'expired'))
          )
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
        order by node.lease_expires_at, node.run_id, node.node_instance_id
        for update of node skip locked
        limit 1
      `;
      const candidate = candidates[0];
      if (!candidate) return null;

      const claim = {
        attemptNumber: candidate.attempt_count,
        fencingToken: candidate.fencing_token,
        nodeDefinitionId: candidate.node_definition_id,
        nodeInstanceId: candidate.node_instance_id,
        runId: candidate.run_id,
        workerId: candidate.worker_id,
        workflowId: candidate.workflow_id,
        correlationId: candidate.correlation_id,
      };

      const runRows = await sql<Array<{ cancellation_requested: boolean }>>`
        select cancellation_requested
        from public.workflow_runs
        where id = ${candidate.run_id}
        for update
      `;
      const run = runRows[0];
      if (!run) throw new Error('Workflow run for expired step is missing.');

      if (run.cancellation_requested) {
        await markExpiredWorkflowAttemptLost(sql, candidate);
        return cancelExpiredWorkflowStep(sql, candidate, claim);
      }

      const definition = input.resolveDefinition(
        candidate.workflow_id,
        candidate.definition_hash,
        candidate.definition_hash_version
      );
      if (!definition) {
        await failWorkflowForMissingDefinition(sql, {
          attemptNumber: candidate.attempt_count,
          failure: MISSING_WORKFLOW_DEFINITION_FAILURE,
          fencingToken: candidate.fencing_token,
          nodeInstanceId: candidate.node_instance_id,
          runId: candidate.run_id,
          workerId: candidate.worker_id,
        });
        return {
          claim,
          failure: MISSING_WORKFLOW_DEFINITION_FAILURE,
          result: {
            nodeInstanceId: candidate.node_instance_id,
            outcome: 'failed' as const,
            runId: candidate.run_id,
          },
        } satisfies ExpiredStepRecoveryLogResult;
      }
      await markExpiredWorkflowAttemptLost(sql, candidate);

      const decision = getRetryDecision({
        attemptNumber: candidate.attempt_count,
        failure: LEASE_EXPIRED_FAILURE,
        maxAttempts: candidate.max_attempts,
        ...(input.random ? { random: input.random } : {}),
      });
      if (!decision.retry) {
        const failed = await failExpiredWorkflowStep(sql, {
          boundary: {
            definitionHash: candidate.definition_hash,
            definitionHashVersion: candidate.definition_hash_version,
            fencingToken: candidate.fencing_token,
            nodeInstanceId: candidate.node_instance_id,
            runId: candidate.run_id,
            stepPolicies: candidate.step_policies,
            stepPoliciesVersion: candidate.step_policies_version,
            workerId: candidate.worker_id,
            workflowId: candidate.workflow_id,
          },
          definition,
          failure: LEASE_EXPIRED_FAILURE,
        });
        return {
          claim,
          failure: LEASE_EXPIRED_FAILURE,
          result: {
            nodeInstanceId: candidate.node_instance_id,
            outcome: failed.runOutcome === 'running' ? 'continued' : failed.runOutcome,
            runId: candidate.run_id,
            ...(failed.transientEvents.length > 0
              ? {
                  transientEvents: failed.transientEvents,
                  workflowId: candidate.workflow_id,
                }
              : {}),
          },
        } satisfies ExpiredStepRecoveryLogResult;
      }

      const nodeRows = await sql`
        update public.workflow_node_runs
        set status = 'retrying',
            error = ${sql.json(asPostgresJson(LEASE_EXPIRED_FAILURE))},
            available_at = clock_timestamp() + (${decision.delayMs} * interval '1 millisecond'),
            worker_id = null,
            lease_expires_at = null,
            fencing_token = fencing_token + 1,
            updated_at = clock_timestamp()
        where run_id = ${candidate.run_id}
          and node_instance_id = ${candidate.node_instance_id}
        returning 1
      `;
      if (nodeRows.length !== 1) throw new Error('Expired workflow step could not be retried.');
      await sql`
        update public.workflow_runs
        set updated_at = clock_timestamp(), version = version + 1
        where id = ${candidate.run_id}
      `;
      await sql`select pg_notify('workflow_ready', ${candidate.run_id})`;
      return {
        claim,
        failure: LEASE_EXPIRED_FAILURE,
        result: {
          nodeInstanceId: candidate.node_instance_id,
          outcome: 'retrying' as const,
          runId: candidate.run_id,
        },
        retryDelayMs: decision.delayMs,
      } satisfies ExpiredStepRecoveryLogResult;
    });
    if (!recovery) return null;
    emitWorkflowLog(this.logger, {
      action: 'recovered',
      claim: recovery.claim,
      entity: 'attempt',
      failure: recovery.failure,
      operation: 'step',
      outcome: recovery.result.outcome,
      ...(recovery.retryDelayMs === undefined ? {} : { retryDelayMs: recovery.retryDelayMs }),
    });
    if (recovery.failure.code === MISSING_WORKFLOW_DEFINITION_FAILURE.code) {
      emitWorkflowLog(this.logger, {
        action: 'definition-unavailable',
        entity: 'run',
        failure: recovery.failure,
        runId: recovery.result.runId,
        runStatus: 'failed',
        workflowId: recovery.claim.workflowId,
      });
    }
    return recovery.result;
  }
}
