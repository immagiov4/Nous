import type { Sql, TransactionSql } from 'postgres';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { buildSha256HexDigest } from '../../src/utils/hash.js';
import { PostgresWorkflowCancellationStore } from '../../src/workflows/postgresWorkflowCancellationStore.js';
import { checkpointWorkflowStep } from '../../src/workflows/postgresWorkflowCheckpoint.js';
import { PostgresWorkflowOutboxStore } from '../../src/workflows/postgresWorkflowOutboxStore.js';
import { PostgresWorkflowSignalStore } from '../../src/workflows/postgresWorkflowSignalStore.js';
import { PostgresWorkflowStepStore } from '../../src/workflows/postgresWorkflowStepStore.js';
import { PostgresWorkflowStore } from '../../src/workflows/postgresWorkflowStore.js';
import {
  PostgresWorkflowUndoStore,
  type WorkflowUndoClaim,
} from '../../src/workflows/postgresWorkflowUndoStore.js';
import { PostgresWorkflowWaitStore } from '../../src/workflows/postgresWorkflowWaitStore.js';
import { canonicalJson } from '../../src/workflows/schemaFingerprint.js';
import type { RegisteredWorkflow, WorkflowStepClaim } from '../../src/workflows/types.js';
import type {
  WorkflowLogEvent,
  WorkflowLogger,
} from '../../src/workflows/workflowObservability.js';

const RUN_ID = '00000000-0000-0000-0000-000000000001';
const NOW = '2026-07-29T10:00:00.000Z';
const STORED_RUN_INPUT = { prompt: 'private prompt' };
const STORED_REQUEST_FINGERPRINT = buildSha256HexDigest(
  new TextEncoder().encode(canonicalJson({ input: STORED_RUN_INPUT, projectId: null }))
);

const createScriptedSql = (...responses: unknown[][]) => {
  let transactionOpen = false;
  const transaction = Object.assign(
    async (strings: TemplateStringsArray | readonly unknown[][], ..._values: unknown[]) => {
      if (!Object.hasOwn(strings, 'raw')) return strings;
      const response = responses.shift();
      if (!response) throw new Error('Unexpected workflow observability query.');
      return response;
    },
    { array: (value: unknown) => value, json: (value: unknown) => value }
  ) as unknown as TransactionSql;
  const sql = Object.assign(transaction, {
    begin: async <T>(callback: (transactionSql: TransactionSql) => Promise<T>): Promise<T> => {
      transactionOpen = true;
      try {
        return await callback(transaction);
      } finally {
        transactionOpen = false;
      }
    },
  }) as unknown as Sql;
  return {
    isTransactionOpen: () => transactionOpen,
    remaining: () => responses.length,
    sql,
  };
};

const captureLogs = (isTransactionOpen: () => boolean) => {
  const events: WorkflowLogEvent[] = [];
  const logger: WorkflowLogger = {
    log: event => {
      expect(isTransactionOpen()).toBe(false);
      events.push(event);
    },
  };
  return { events, logger };
};

const storedRun = {
  cancellation_requested: false,
  cleanup_status: 'not-required',
  completed_at: null,
  created_at: NOW,
  definition_hash: 'a'.repeat(64),
  definition_hash_version: 1,
  error: null,
  id: RUN_ID,
  input: STORED_RUN_INPUT,
  output: null,
  project_id: null,
  request_fingerprint: STORED_REQUEST_FINGERPRINT,
  request_key: 'private-request-key',
  resolved_config: { apiKey: 'private-key' },
  status: 'queued',
  started_at: null,
  step_policies: {
    generate: {
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      maxAttempts: 3,
      timeoutMs: 60_000,
    },
  },
  step_policies_version: 1,
  updated_at: NOW,
  user_id: 'private-user',
  workflow_id: 'lesson-generation',
};

const stepClaim: WorkflowStepClaim = {
  attemptNumber: 1,
  definitionHash: 'a'.repeat(64),
  definitionHashVersion: 1,
  fencingToken: '1',
  input: { prompt: 'private step input' },
  kind: 'step',
  leaseExpiresAt: NOW,
  maxAttempts: 3,
  nodeDefinitionId: 'generate',
  nodeInstanceId: 'root/private-item/generate',
  retryFeedback: '',
  runId: RUN_ID,
  stepPolicies: {
    generate: {
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      maxAttempts: 3,
      timeoutMs: 60_000,
    },
  },
  stepPoliciesVersion: 1,
  timeoutMs: 60_000,
  userId: 'private-user',
  workerId: 'private-step-worker',
  workflowId: 'lesson-generation',
};

const definition = {
  definitionHash: stepClaim.definitionHash,
  definitionHashVersion: stepClaim.definitionHashVersion,
  id: stepClaim.workflowId,
} as RegisteredWorkflow;

const undoClaim: WorkflowUndoClaim = {
  attemptNumber: 1,
  definitionHash: stepClaim.definitionHash,
  definitionHashVersion: stepClaim.definitionHashVersion,
  fencingToken: '1',
  input: { content: 'private undo input' },
  leaseExpiresAt: NOW,
  maxAttempts: 3,
  nodeDefinitionId: 'persist',
  nodeInstanceId: 'root/private-item/persist',
  output: { content: 'private undo output' },
  runId: RUN_ID,
  stepPolicies: {
    persist: {
      config: { apiKey: 'private-key', maxAttempts: 3, timeoutMs: 60_000 },
      maxAttempts: 3,
      timeoutMs: 60_000,
    },
  },
  stepPoliciesVersion: 1,
  timeoutMs: 60_000,
  userId: 'private-user',
  workerId: 'private-undo-worker',
  workflowId: 'lesson-generation',
};

describe('PostgreSQL workflow observability', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('logs run creation and deduplication only after their transactions commit', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    vi.stubEnv('SUPABASE_URL', 'https://storage.example.test');
    const database = createScriptedSql([], [], [storedRun], [], [], [], [], [], [storedRun]);
    const logs = captureLogs(database.isTransactionOpen);
    const store = new PostgresWorkflowStore({
      enforceCurrentDefinitions: false,
      listenClientFactory: () => database.sql,
      logger: logs.logger,
      sqlClient: database.sql,
    });
    const input = {
      config: { apiKey: 'private-key' },
      definitionHash: 'a'.repeat(64),
      definitionHashVersion: 1,
      id: RUN_ID,
      input: { prompt: 'private prompt' },
      materialization: {
        durableEvents: [],
        nodes: [
          {
            definitionId: 'generate',
            hasUndo: false,
            input: { prompt: 'private prompt' },
            instanceId: 'generate',
            kind: 'step' as const,
            maxAttempts: 3,
            parentInstanceId: undefined,
            runtimeState: undefined,
            status: 'queued' as const,
            timeoutMs: 60_000,
          },
        ],
        stepPolicies: {
          generate: {
            config: { maxAttempts: 3, timeoutMs: 60_000 },
            maxAttempts: 3,
            timeoutMs: 60_000,
          },
        },
        stepPoliciesVersion: 1,
        transientEvents: [],
        waits: [
          {
            nodeInstanceId: 'root/private-item/approval',
            signalType: 'approve',
            waitId: 'wait-1',
          },
        ],
      },
      requestKey: 'private-request-key',
      userId: 'private-user',
      workflowId: 'lesson-generation',
    };

    await expect(store.createRun(input)).resolves.toMatchObject({ created: true });
    await expect(store.createRun(input)).resolves.toMatchObject({ created: false });

    expect(logs.events).toEqual([
      expect.objectContaining({ action: 'created', event: 'workflow.run', runId: RUN_ID }),
      expect.objectContaining({
        action: 'created',
        event: 'workflow.wait',
        runId: RUN_ID,
        waitId: 'wait-1',
      }),
      expect.objectContaining({ action: 'deduplicated', event: 'workflow.run', runId: RUN_ID }),
    ]);
    expect(JSON.stringify(logs.events)).not.toContain('private');
    expect(database.remaining()).toBe(0);
  });

  test('logs step and undo claims after the claim transactions commit', async () => {
    const stepDatabase = createScriptedSql(
      [
        {
          attempt_count: 0,
          definition_hash: 'a'.repeat(64),
          definition_hash_version: 1,
          input: { prompt: 'private step input' },
          kind: 'step',
          max_attempts: 3,
          node_definition_id: 'generate',
          node_instance_id: 'root/private-item/generate',
          previous_error: null,
          run_id: RUN_ID,
          step_policies: {
            generate: {
              config: { maxAttempts: 3, timeoutMs: 60_000 },
              maxAttempts: 3,
              timeoutMs: 60_000,
            },
          },
          step_policies_version: 1,
          timeout_ms: 60_000,
          user_id: 'private-user',
          workflow_id: 'lesson-generation',
        },
      ],
      [{ cancellation_requested: false, status: 'queued' }],
      [{ attempt_count: 1, fencing_token: '1', lease_expires_at: NOW }],
      [],
      []
    );
    const stepLogs = captureLogs(stepDatabase.isTransactionOpen);
    const stepClaim = await new PostgresWorkflowStepStore(
      stepDatabase.sql,
      stepLogs.logger
    ).claimNext({
      leaseMs: 60_000,
      supportedDefinitions: [
        {
          definitionHash: definition.definitionHash,
          definitionHashVersion: definition.definitionHashVersion,
          workflowId: definition.id,
        },
      ],
      workerId: 'private-step-worker',
    });

    const undoDatabase = createScriptedSql(
      [
        {
          attempt_count: 0,
          definition_hash: 'a'.repeat(64),
          definition_hash_version: 1,
          input: { content: 'private undo input' },
          max_attempts: 3,
          node_definition_id: 'persist',
          node_instance_id: 'root/private-item/persist',
          output: { content: 'private undo output' },
          run_id: RUN_ID,
          step_policies: {
            persist: {
              config: { apiKey: 'private-key', maxAttempts: 3, timeoutMs: 60_000 },
              maxAttempts: 3,
              timeoutMs: 60_000,
            },
          },
          step_policies_version: 1,
          timeout_ms: 60_000,
          user_id: 'private-user',
          workflow_id: 'lesson-generation',
        },
      ],
      [{ '?column?': 1 }],
      [{ attempt_count: 1, fencing_token: '1', lease_expires_at: NOW }],
      [],
      []
    );
    const undoLogs = captureLogs(undoDatabase.isTransactionOpen);
    const undoClaim = await new PostgresWorkflowUndoStore(
      undoDatabase.sql,
      undoLogs.logger
    ).claimNext({
      leaseMs: 60_000,
      supportedDefinitions: [
        {
          definitionHash: definition.definitionHash,
          definitionHashVersion: definition.definitionHashVersion,
          workflowId: definition.id,
        },
      ],
      workerId: 'private-undo-worker',
    });

    expect(stepClaim).not.toBeNull();
    expect(undoClaim).not.toBeNull();
    expect(stepLogs.events).toEqual([
      expect.objectContaining({ action: 'claimed', event: 'workflow.attempt', operation: 'step' }),
    ]);
    expect(undoLogs.events).toEqual([
      expect.objectContaining({ action: 'claimed', event: 'workflow.attempt', operation: 'undo' }),
    ]);
    expect(JSON.stringify([...stepLogs.events, ...undoLogs.events])).not.toContain('private');
    expect(stepDatabase.remaining()).toBe(0);
    expect(undoDatabase.remaining()).toBe(0);
  });

  test('logs cancellation and wait expiry after their transactions commit', async () => {
    const cancellationDatabase = createScriptedSql(
      [{ cancellation_requested: false, cleanup_status: 'not-required', status: 'running' }],
      [],
      []
    );
    const cancellationLogs = captureLogs(cancellationDatabase.isTransactionOpen);
    await new PostgresWorkflowCancellationStore(
      cancellationDatabase.sql,
      cancellationLogs.logger
    ).request({ runId: RUN_ID, userId: 'private-user' });

    const waitDatabase = createScriptedSql(
      [
        {
          node_instance_id: 'root/private-item/approval',
          run_id: RUN_ID,
          signal_type: 'approve',
          wait_id: 'wait-1',
        },
      ],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [],
      [],
      []
    );
    const waitLogs = captureLogs(waitDatabase.isTransactionOpen);
    await new PostgresWorkflowWaitStore(waitDatabase.sql, waitLogs.logger).expireNext();

    expect(cancellationLogs.events).toEqual([
      expect.objectContaining({
        action: 'cancellation-requested',
        event: 'workflow.run',
        runId: RUN_ID,
      }),
    ]);
    expect(waitLogs.events).toEqual([
      expect.objectContaining({
        action: 'expired',
        event: 'workflow.wait',
        failureCode: 'workflow_wait_expired',
        waitId: 'wait-1',
      }),
    ]);
    expect(JSON.stringify(waitLogs.events)).not.toContain('private-item');
    expect(cancellationDatabase.remaining()).toBe(0);
    expect(waitDatabase.remaining()).toBe(0);
  });

  test('logs outbox claim, lease loss, delivery, and retry without its payload', async () => {
    const database = createScriptedSql(
      [
        {
          attempt_count: 1,
          event_type: 'lesson.ready',
          fencing_token: '1',
          id: 'notification-1',
          lease_expires_at: NOW,
          payload: { lesson: 'private generated lesson' },
          run_id: RUN_ID,
          schema_version: 1,
          sequence: '7',
          user_id: 'private-user',
        },
      ],
      [],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }]
    );
    const logs = captureLogs(database.isTransactionOpen);
    const outbox = new PostgresWorkflowOutboxStore(database.sql, logs.logger);
    const claim = await outbox.claimNext({ leaseMs: 60_000, workerId: 'private-outbox-worker' });
    if (!claim) throw new Error('Expected an outbox claim.');

    await expect(outbox.heartbeat({ claim, leaseMs: 60_000 })).resolves.toEqual({ status: 'lost' });
    await outbox.markDelivered(claim);
    await outbox.recordFailure({
      claim,
      failure: {
        code: 'notification_delivery_failed',
        details: { response: 'private provider response' },
        kind: 'operational',
        message: 'private delivery failure',
      },
      retryDelayMs: 2_000,
    });

    expect(logs.events.map(event => event.action)).toEqual([
      'claimed',
      'lease-lost',
      'delivered',
      'retry-scheduled',
    ]);
    expect(JSON.stringify(logs.events)).not.toContain('private');
    expect(database.remaining()).toBe(0);
  });

  test('logs checkpoint replay and step retry only after their transactions commit', async () => {
    const checkpointDatabase = createScriptedSql([
      {
        attempt_status: 'completed',
        fencing_token: stepClaim.fencingToken,
        lease_valid: null,
        node_status: 'completed',
        worker_id: null,
      },
    ]);
    const checkpointLogs = captureLogs(checkpointDatabase.isTransactionOpen);
    await expect(
      checkpointWorkflowStep(
        checkpointDatabase.sql,
        { claim: stepClaim, definition, output: { content: 'private output' } },
        { logger: checkpointLogs.logger }
      )
    ).resolves.toEqual({ status: 'already-checkpointed' });

    const retryDatabase = createScriptedSql(
      [{ lease_valid: true }],
      [{ cancellation_requested: false }],
      [{ '?column?': 1 }],
      [{ available_at: NOW }],
      [],
      []
    );
    const retryLogs = captureLogs(retryDatabase.isTransactionOpen);
    await expect(
      new PostgresWorkflowStepStore(retryDatabase.sql, retryLogs.logger).recordFailure({
        claim: stepClaim,
        definition,
        failure: {
          code: 'provider_unavailable',
          details: { response: 'private provider response' },
          kind: 'operational',
          message: 'private provider failure',
        },
        random: () => 0,
      })
    ).resolves.toMatchObject({ status: 'retrying' });

    expect(checkpointLogs.events).toEqual([
      expect.objectContaining({
        action: 'checkpoint-replayed',
        event: 'workflow.attempt',
        outcome: 'completed',
      }),
    ]);
    expect(retryLogs.events).toEqual([
      expect.objectContaining({
        action: 'retry-scheduled',
        event: 'workflow.attempt',
        failureCode: 'provider_unavailable',
        operation: 'step',
        outcome: 'retrying',
      }),
    ]);
    expect(JSON.stringify([...checkpointLogs.events, ...retryLogs.events])).not.toContain(
      'private'
    );
    expect(checkpointDatabase.remaining()).toBe(0);
    expect(retryDatabase.remaining()).toBe(0);
  });

  test('logs expired step recovery with the original fenced attempt identity', async () => {
    const database = createScriptedSql(
      [
        {
          attempt_count: 1,
          definition_hash: stepClaim.definitionHash,
          definition_hash_version: stepClaim.definitionHashVersion,
          fencing_token: stepClaim.fencingToken,
          max_attempts: stepClaim.maxAttempts,
          node_definition_id: stepClaim.nodeDefinitionId,
          node_instance_id: stepClaim.nodeInstanceId,
          run_id: stepClaim.runId,
          step_policies: stepClaim.stepPolicies,
          worker_id: stepClaim.workerId,
          workflow_id: stepClaim.workflowId,
        },
      ],
      [{ cancellation_requested: false }],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [],
      []
    );
    const logs = captureLogs(database.isTransactionOpen);

    await expect(
      new PostgresWorkflowStepStore(database.sql, logs.logger).recoverNextExpired({
        random: () => 0,
        resolveDefinition: () => definition,
        supportedDefinitions: [
          {
            definitionHash: definition.definitionHash,
            definitionHashVersion: definition.definitionHashVersion,
            workflowId: definition.id,
          },
        ],
      })
    ).resolves.toEqual({
      nodeInstanceId: stepClaim.nodeInstanceId,
      outcome: 'retrying',
      runId: RUN_ID,
    });

    expect(logs.events).toEqual([
      expect.objectContaining({
        action: 'recovered',
        attemptNumber: stepClaim.attemptNumber,
        event: 'workflow.attempt',
        failureCode: 'worker_lease_expired',
        fencingToken: stepClaim.fencingToken,
        operation: 'step',
        outcome: 'retrying',
      }),
    ]);
    expect(JSON.stringify(logs.events)).not.toContain('private');
    expect(database.remaining()).toBe(0);
  });

  test('logs undo completion and retry only after their transactions commit', async () => {
    const completionDatabase = createScriptedSql(
      [{ lease_valid: true }],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [],
      []
    );
    const completionLogs = captureLogs(completionDatabase.isTransactionOpen);
    await expect(
      new PostgresWorkflowUndoStore(completionDatabase.sql, completionLogs.logger).complete(
        undoClaim
      )
    ).resolves.toEqual({ cleanupStatus: 'completed' });

    const retryDatabase = createScriptedSql(
      [{ lease_valid: true }],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [{ available_at: NOW }],
      [],
      []
    );
    const retryLogs = captureLogs(retryDatabase.isTransactionOpen);
    await expect(
      new PostgresWorkflowUndoStore(retryDatabase.sql, retryLogs.logger).recordFailure({
        claim: undoClaim,
        failure: {
          code: 'undo_temporarily_unavailable',
          details: { response: 'private undo response' },
          kind: 'operational',
          message: 'private undo failure',
        },
        random: () => 0,
      })
    ).resolves.toMatchObject({ status: 'retrying' });

    expect(completionLogs.events).toEqual([
      expect.objectContaining({
        action: 'completed',
        cleanupStatus: 'completed',
        event: 'workflow.attempt',
        operation: 'undo',
      }),
    ]);
    expect(retryLogs.events).toEqual([
      expect.objectContaining({
        action: 'retry-scheduled',
        event: 'workflow.attempt',
        failureCode: 'undo_temporarily_unavailable',
        operation: 'undo',
      }),
    ]);
    expect(JSON.stringify([...completionLogs.events, ...retryLogs.events])).not.toContain(
      'private'
    );
    expect(completionDatabase.remaining()).toBe(0);
    expect(retryDatabase.remaining()).toBe(0);
  });

  test('replays without a definition and logs no request key, user, or payload', async () => {
    const signalDefinition = {
      ...definition,
      signals: { approve: { schema: z.object({ approved: z.boolean() }), schemaVersion: 1 } },
    } as RegisteredWorkflow;
    const database = createScriptedSql(
      [{ node_instance_id: 'root/private-item/approval', run_id: RUN_ID, status: 'waiting' }],
      [
        {
          cancellation_requested: false,
          definition_hash: signalDefinition.definitionHash,
          definition_hash_version: signalDefinition.definitionHashVersion,
          status: 'waiting',
          step_policies: {},
          step_policies_version: 1,
          user_id: 'private-user',
          workflow_id: signalDefinition.id,
        },
      ],
      [
        {
          not_expired: true,
          signal_schema_version: 1,
          signal_type: 'approve',
          status: 'waiting',
        },
      ],
      [{ request_payload: { approved: true }, signal_type: 'approve', wait_id: 'wait-1' }]
    );
    const logs = captureLogs(database.isTransactionOpen);
    const resolveDefinition = vi.fn(() => null);

    await expect(
      new PostgresWorkflowSignalStore(database.sql, logs.logger).receive({
        payload: { approved: true },
        requestKey: 'private-request-key',
        resolveDefinition,
        runId: RUN_ID,
        signalType: 'approve',
        userId: 'private-user',
        waitId: 'wait-1',
      })
    ).resolves.toEqual({ runId: RUN_ID, status: 'replayed' });
    expect(resolveDefinition).not.toHaveBeenCalled();

    expect(logs.events).toEqual([
      expect.objectContaining({
        action: 'signal-replayed',
        event: 'workflow.wait',
        runId: RUN_ID,
        signalType: 'approve',
        waitId: 'wait-1',
      }),
    ]);
    expect(JSON.stringify(logs.events)).not.toContain('private');
    expect(database.remaining()).toBe(0);
  });
});
