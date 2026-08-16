import type { Sql } from 'postgres';
import { describe, expect, test } from 'vitest';

import {
  PostgresWorkflowOutboxStore,
  type WorkflowOutboxClaim,
} from '../../src/workflows/postgresWorkflowOutboxStore.js';
import type {
  WorkflowLogEvent,
  WorkflowLogger,
} from '../../src/workflows/workflowObservability.js';

const NOW = '2026-08-10T10:00:00.000Z';

const claim: WorkflowOutboxClaim = {
  attemptNumber: 1,
  correlationId: '123e4567-e89b-42d3-a456-426614174000',
  eventType: 'lesson.ready',
  fencingToken: '1',
  id: '00000000-0000-0000-0000-000000000001',
  leaseExpiresAt: NOW,
  payload: { lessonId: 'lesson-1' },
  runId: '00000000-0000-0000-0000-000000000002',
  schemaVersion: 1,
  sequence: '1',
  userId: '00000000-0000-0000-0000-000000000003',
  workerId: 'delivery-worker',
};

const createScriptedSql = (...responses: unknown[][]) => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join('?'), values });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected outbox query.');
      return response;
    },
    {
      begin: async <Result>(run: (transaction: Sql) => Promise<Result>) => run(sql),
      json: (value: unknown) => value,
    }
  ) as unknown as Sql;
  return { queries, remaining: () => responses.length, sql };
};

const captureLogs = () => {
  const events: WorkflowLogEvent[] = [];
  const logger: WorkflowLogger = { log: event => events.push(event) };
  return { events, logger };
};

describe('PostgresWorkflowOutboxStore', () => {
  test.each([
    ['permanent', 'dead-letter', 'dead-lettered'],
    ['corrective', 'dead-letter', 'dead-lettered'],
    ['operational', 'pending', 'retry-scheduled'],
  ] as const)('persists a %s delivery failure as %s', async (kind, status, action) => {
    const database = createScriptedSql([{ '?column?': 1 }]);
    const logs = captureLogs();

    await new PostgresWorkflowOutboxStore(database.sql, logs.logger).recordFailure({
      claim,
      failure: {
        code: 'delivery_failed',
        ...(kind === 'corrective' ? { feedback: 'Correct the durable event.' } : {}),
        kind,
        message: 'Delivery failed.',
      },
      retryDelayMs: 0,
    });

    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.values).toContain(status);
    expect(logs.events).toEqual([
      expect.objectContaining({ action, failureCode: 'delivery_failed' }),
    ]);
    expect(database.remaining()).toBe(0);
  });

  test('lists persisted diagnostics and explicitly requeues one dead letter', async () => {
    const database = createScriptedSql(
      [
        {
          attempt_count: 2,
          created_at: NOW,
          dead_lettered_at: NOW,
          event_type: 'lesson.ready',
          id: claim.id,
          last_error: {
            code: 'notification_unsupported',
            kind: 'permanent',
            message: 'Unsupported notification.',
          },
          payload: claim.payload,
          run_id: claim.runId,
          schema_version: 1,
          sequence: '1',
          user_id: claim.userId,
        },
      ],
      [
        {
          attempt_count: 2,
          event_type: 'lesson.ready',
          fencing_token: '1',
          id: claim.id,
          run_id: claim.runId,
          schema_version: 1,
          sequence: '1',
        },
      ],
      []
    );
    const logs = captureLogs();
    const store = new PostgresWorkflowOutboxStore(database.sql, logs.logger);

    await expect(store.listDeadLetters()).resolves.toEqual([
      {
        attemptCount: 2,
        createdAt: NOW,
        deadLetteredAt: NOW,
        eventType: 'lesson.ready',
        failure: {
          code: 'notification_unsupported',
          kind: 'permanent',
          message: 'Unsupported notification.',
        },
        id: claim.id,
        payload: claim.payload,
        runId: claim.runId,
        schemaVersion: 1,
        sequence: '1',
        userId: claim.userId,
      },
    ]);
    await expect(store.retryDeadLetter({ id: claim.id, requestedBy: 'admin-user' })).resolves.toBe(
      true
    );
    expect(logs.events).toEqual([
      expect.objectContaining({ action: 'requeued', notificationId: claim.id }),
    ]);
    expect(database.queries[2]?.text).toContain('workflow_notification_ready');
    expect(database.remaining()).toBe(0);
  });
});
