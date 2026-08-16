import type { Sql } from 'postgres';

import { asPostgresJson, toIsoString } from './postgresWorkflowPersistence.js';
import { parseStepFailure } from './retryPolicy.js';
import type { JsonValue, StepFailure } from './types.js';
import { WorkflowOutboxLeaseLostError } from './workflowErrors.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  type WorkflowLogger,
} from './workflowObservability.js';

interface OutboxClaimRow {
  attempt_count: number;
  correlation_id: string;
  event_type: string;
  fencing_token: string;
  id: string;
  lease_expires_at: Date | string;
  payload: JsonValue;
  run_id: string;
  schema_version: number;
  sequence: string;
  user_id: string;
}

interface OutboxHeartbeatRow {
  lease_expires_at: Date | string;
}

interface OutboxDeadLetterRow {
  attempt_count: number;
  created_at: Date | string;
  dead_lettered_at: Date | string;
  event_type: string;
  id: string;
  last_error: StepFailure;
  payload: JsonValue;
  run_id: string;
  schema_version: number;
  sequence: string;
  user_id: string;
}

interface OutboxRetryRow {
  attempt_count: number;
  event_type: string;
  fencing_token: string;
  id: string;
  run_id: string;
  schema_version: number;
  sequence: string;
}

export interface WorkflowOutboxClaim {
  attemptNumber: number;
  correlationId: string;
  eventType: string;
  fencingToken: string;
  id: string;
  leaseExpiresAt: string;
  payload: JsonValue;
  runId: string;
  schemaVersion: number;
  sequence: string;
  userId: string;
  workerId: string;
}

export type WorkflowOutboxHeartbeatResult =
  | { leaseExpiresAt: string; status: 'renewed' }
  | { status: 'lost' };

export interface WorkflowOutboxDeadLetter {
  attemptCount: number;
  createdAt: string;
  deadLetteredAt: string;
  eventType: string;
  failure: StepFailure;
  id: string;
  payload: JsonValue;
  runId: string;
  schemaVersion: number;
  sequence: string;
  userId: string;
}

const DELIVERY_LEASE_EXPIRED_FAILURE: StepFailure = {
  code: 'notification_lease_expired',
  kind: 'operational',
  message: 'The durable notification delivery lease expired.',
};

const assertPositiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
};

const assertNonNegativeInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
};

export class PostgresWorkflowOutboxStore {
  constructor(
    private readonly sql: Sql,
    private readonly logger: WorkflowLogger = consoleWorkflowLogger
  ) {}

  async claimNext(input: {
    leaseMs: number;
    workerId: string;
  }): Promise<WorkflowOutboxClaim | null> {
    assertPositiveInteger(input.leaseMs, 'leaseMs');
    if (!input.workerId.trim()) throw new Error('workerId is required.');

    const claim = await this.sql.begin(async sql => {
      const rows = await sql<OutboxClaimRow[]>`
        with candidate as (
          select event.id, run.correlation_id, run.user_id
          from public.workflow_outbox event
          join public.workflow_runs run on run.id = event.run_id
          where (event.status = 'pending' and event.available_at <= clock_timestamp())
             or (event.status = 'delivering' and event.lease_expires_at <= clock_timestamp())
          order by
            case when event.status = 'pending' then event.available_at else event.lease_expires_at end,
            event.created_at,
            event.id
          for update of event skip locked
          limit 1
        )
        update public.workflow_outbox event
        set status = 'delivering',
            worker_id = ${input.workerId},
            lease_expires_at = clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
            fencing_token = event.fencing_token + 1,
            attempt_count = event.attempt_count + 1,
            last_error = case
              when event.status = 'delivering'
                then ${sql.json(asPostgresJson(DELIVERY_LEASE_EXPIRED_FAILURE))}
              else event.last_error
            end
        from candidate
        where event.id = candidate.id
        returning
          event.id, event.run_id, event.sequence::text, event.event_type,
          event.schema_version, event.payload, event.attempt_count,
          event.fencing_token::text, event.lease_expires_at,
          candidate.correlation_id, candidate.user_id
      `;
      const event = rows[0];
      if (!event) return null;
      return {
        attemptNumber: event.attempt_count,
        correlationId: event.correlation_id,
        eventType: event.event_type,
        fencingToken: event.fencing_token,
        id: event.id,
        leaseExpiresAt: toIsoString(event.lease_expires_at),
        payload: event.payload,
        runId: event.run_id,
        schemaVersion: event.schema_version,
        sequence: event.sequence,
        userId: event.user_id,
        workerId: input.workerId,
      };
    });
    if (claim) {
      emitWorkflowLog(this.logger, {
        action: 'claimed',
        claim,
        entity: 'notification',
      });
    }
    return claim;
  }

  async heartbeat(input: {
    claim: WorkflowOutboxClaim;
    leaseMs: number;
  }): Promise<WorkflowOutboxHeartbeatResult> {
    assertPositiveInteger(input.leaseMs, 'leaseMs');
    const rows = await this.sql<OutboxHeartbeatRow[]>`
      update public.workflow_outbox
      set lease_expires_at = clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')
      where id = ${input.claim.id}
        and status = 'delivering'
        and worker_id = ${input.claim.workerId}
        and fencing_token = ${input.claim.fencingToken}
        and lease_expires_at > clock_timestamp()
      returning lease_expires_at
    `;
    const event = rows[0];
    if (event) return { leaseExpiresAt: toIsoString(event.lease_expires_at), status: 'renewed' };
    emitWorkflowLog(this.logger, {
      action: 'lease-lost',
      claim: input.claim,
      entity: 'notification',
    });
    return { status: 'lost' };
  }

  async markDelivered(claim: WorkflowOutboxClaim): Promise<void> {
    const rows = await this.sql`
      update public.workflow_outbox
      set status = 'delivered',
          worker_id = null,
          lease_expires_at = null,
          last_error = null,
          delivered_at = clock_timestamp()
      where id = ${claim.id}
        and status = 'delivering'
        and worker_id = ${claim.workerId}
        and fencing_token = ${claim.fencingToken}
        and lease_expires_at > clock_timestamp()
      returning 1
    `;
    if (rows.length !== 1) throw new WorkflowOutboxLeaseLostError();
    emitWorkflowLog(this.logger, {
      action: 'delivered',
      claim,
      entity: 'notification',
    });
  }

  async recordFailure(input: {
    claim: WorkflowOutboxClaim;
    failure: StepFailure;
    retryDelayMs: number;
  }): Promise<void> {
    assertNonNegativeInteger(input.retryDelayMs, 'retryDelayMs');
    const failure = parseStepFailure(input.failure);
    const status = failure.kind === 'operational' ? 'pending' : 'dead-letter';
    const rows = await this.sql`
      update public.workflow_outbox
      set status = ${status},
          available_at = case
            when ${status} = 'pending'
              then clock_timestamp() + (${input.retryDelayMs} * interval '1 millisecond')
            else available_at
          end,
          worker_id = null,
          lease_expires_at = null,
          dead_lettered_at = case when ${status} = 'dead-letter' then clock_timestamp() else null end,
          last_error = ${this.sql.json(asPostgresJson(failure))}
      where id = ${input.claim.id}
        and status = 'delivering'
        and worker_id = ${input.claim.workerId}
        and fencing_token = ${input.claim.fencingToken}
        and lease_expires_at > clock_timestamp()
      returning 1
    `;
    if (rows.length !== 1) throw new WorkflowOutboxLeaseLostError();
    emitWorkflowLog(this.logger, {
      action: status === 'dead-letter' ? 'dead-lettered' : 'retry-scheduled',
      claim: input.claim,
      entity: 'notification',
      failure,
      ...(status === 'pending' ? { retryDelayMs: input.retryDelayMs } : {}),
    });
  }

  async listDeadLetters(): Promise<readonly WorkflowOutboxDeadLetter[]> {
    const rows = await this.sql<OutboxDeadLetterRow[]>`
      select
        event.id, event.run_id, event.sequence::text, event.event_type,
        event.schema_version, event.payload, event.attempt_count,
        event.last_error, event.created_at, event.dead_lettered_at, run.user_id
      from public.workflow_outbox event
      join public.workflow_runs run on run.id = event.run_id
      where event.status = 'dead-letter'
      order by event.dead_lettered_at desc, event.id
    `;
    return rows.map(row => ({
      attemptCount: row.attempt_count,
      createdAt: toIsoString(row.created_at),
      deadLetteredAt: toIsoString(row.dead_lettered_at),
      eventType: row.event_type,
      failure: parseStepFailure(row.last_error),
      id: row.id,
      payload: row.payload,
      runId: row.run_id,
      schemaVersion: row.schema_version,
      sequence: row.sequence,
      userId: row.user_id,
    }));
  }

  async retryDeadLetter(input: { id: string; requestedBy: string }): Promise<boolean> {
    if (!input.id.trim()) throw new Error('id is required.');
    if (!input.requestedBy.trim()) throw new Error('requestedBy is required.');
    const event = await this.sql.begin(async sql => {
      const rows = await sql<OutboxRetryRow[]>`
        update public.workflow_outbox
        set status = 'pending',
            available_at = clock_timestamp(),
            dead_lettered_at = null
        where id = ${input.id}
          and status = 'dead-letter'
        returning
          id, run_id, sequence::text, event_type, schema_version,
          attempt_count, fencing_token::text
      `;
      const requeued = rows[0];
      if (requeued) await sql`select pg_notify('workflow_notification_ready', ${requeued.run_id})`;
      return requeued;
    });
    if (!event) return false;
    emitWorkflowLog(this.logger, {
      action: 'requeued',
      actorId: input.requestedBy,
      claim: {
        attemptNumber: event.attempt_count,
        eventType: event.event_type,
        fencingToken: event.fencing_token,
        id: event.id,
        runId: event.run_id,
        schemaVersion: event.schema_version,
        sequence: event.sequence,
      },
      entity: 'notification',
    });
    return true;
  }
}
