import type { Sql, TransactionSql } from 'postgres';
import { describe, expect, test } from 'vitest';

import { PostgresWorkflowUndoStore } from '../../src/workflows/postgresWorkflowUndoStore.js';
import type { WorkflowLogEvent } from '../../src/workflows/workflowObservability.js';

const SUPPORTED_DEFINITIONS = [
  {
    definitionHash: 'a'.repeat(64),
    definitionHashVersion: 1,
    workflowId: 'lesson-generation',
  },
];

const createScriptedSql = (...responses: unknown[][]): { remaining: () => number; sql: Sql } => {
  const transaction = Object.assign(
    async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected workflow undo recovery query.');
      return response;
    },
    { array: (value: unknown) => value, json: (value: unknown) => value }
  ) as unknown as TransactionSql;
  const sql = Object.assign(transaction, {
    begin: async <T>(callback: (transactionSql: TransactionSql) => Promise<T>): Promise<T> =>
      callback(transaction),
  }) as unknown as Sql;
  return { remaining: () => responses.length, sql };
};

const expiredUndo = (attemptNumber: number) => ({
  attempt_count: attemptNumber,
  fencing_token: '4',
  max_attempts: 3,
  node_instance_id: 'lesson/save',
  run_id: '00000000-0000-0000-0000-000000000001',
  worker_id: 'worker-a',
});

describe('workflow undo recovery', () => {
  test('requeues exhausted undo work on startup without erasing its persisted failure', async () => {
    const database = createScriptedSql([
      {
        cleanup_status: 'pending',
        run_id: '00000000-0000-0000-0000-000000000001',
        run_status: 'failed',
        workflow_id: 'lesson-generation',
      },
    ]);
    const logEvents: WorkflowLogEvent[] = [];

    await expect(
      new PostgresWorkflowUndoStore(database.sql, {
        log: event => logEvents.push(event),
      }).requeueFailed({ supportedDefinitions: SUPPORTED_DEFINITIONS })
    ).resolves.toBe(1);

    expect(logEvents).toEqual([
      expect.objectContaining({
        action: 'reconciled',
        cleanupStatus: 'pending',
        event: 'workflow.run',
        runId: '00000000-0000-0000-0000-000000000001',
        runStatus: 'failed',
        workflowId: 'lesson-generation',
      }),
    ]);
    expect(database.remaining()).toBe(0);
  });

  test('does not requeue work when this worker supports no workflow definition', async () => {
    const database = createScriptedSql();

    await expect(
      new PostgresWorkflowUndoStore(database.sql).requeueFailed({ supportedDefinitions: [] })
    ).resolves.toBe(0);
    expect(database.remaining()).toBe(0);
  });

  test('does nothing when PostgreSQL finds no expired lease', async () => {
    const database = createScriptedSql([]);

    await expect(
      new PostgresWorkflowUndoStore(database.sql).recoverNextExpired({
        supportedDefinitions: SUPPORTED_DEFINITIONS,
      })
    ).resolves.toBeNull();
    expect(database.remaining()).toBe(0);
  });

  test('does not recover work when this worker supports no workflow definition', async () => {
    const database = createScriptedSql();

    await expect(
      new PostgresWorkflowUndoStore(database.sql).recoverNextExpired({ supportedDefinitions: [] })
    ).resolves.toBeNull();
    expect(database.remaining()).toBe(0);
  });

  test('requeues the selected expired lease with the shared retry policy', async () => {
    const database = createScriptedSql(
      [expiredUndo(1)],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      []
    );

    const logEvents: WorkflowLogEvent[] = [];
    await expect(
      new PostgresWorkflowUndoStore(database.sql, {
        log: event => logEvents.push(event),
      }).recoverNextExpired({ random: () => 0, supportedDefinitions: SUPPORTED_DEFINITIONS })
    ).resolves.toEqual({
      nodeInstanceId: 'lesson/save',
      outcome: 'retrying',
      runId: '00000000-0000-0000-0000-000000000001',
    });
    expect(logEvents).toEqual([
      expect.objectContaining({
        action: 'recovered',
        attemptNumber: 1,
        event: 'workflow.attempt',
        failureCode: 'undo_lease_expired',
        operation: 'undo',
        outcome: 'retrying',
        runId: '00000000-0000-0000-0000-000000000001',
      }),
    ]);
    expect(JSON.stringify(logEvents)).not.toContain('lesson/save');
    expect(JSON.stringify(logEvents)).not.toContain('worker-a');
    expect(database.remaining()).toBe(0);
  });

  test('fails cleanup after the expired undo exhausts its attempts', async () => {
    const database = createScriptedSql(
      [expiredUndo(3)],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }],
      [{ '?column?': 1 }]
    );

    await expect(
      new PostgresWorkflowUndoStore(database.sql).recoverNextExpired({
        random: () => 0,
        supportedDefinitions: SUPPORTED_DEFINITIONS,
      })
    ).resolves.toEqual({
      nodeInstanceId: 'lesson/save',
      outcome: 'failed',
      runId: '00000000-0000-0000-0000-000000000001',
    });
    expect(database.remaining()).toBe(0);
  });
});
