import type { Sql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { PostgresProjectRevisionInbox } from '../../src/workflows/postgresProjectRevisionInbox.js';
import type { WorkflowListenClient } from '../../src/workflows/postgresWorkflowWakeSource.js';
import type { WorkflowStepError } from '../../src/workflows/retryPolicy.js';

const makeListener = () => {
  let notify = (_payload: string): void => undefined;
  let ready = (): void => undefined;
  const client: WorkflowListenClient = {
    end: vi.fn(async () => undefined),
    listen: vi.fn(async (_channel, onNotify, onListen) => {
      notify = onNotify;
      ready = onListen ?? (() => undefined);
      return { unlisten: vi.fn(async () => undefined) };
    }),
  };
  return {
    client,
    notify: (payload: string) => notify(payload),
    ready: () => ready(),
  };
};

describe('PostgreSQL project revision inbox', () => {
  test('requests an authoritative catch-up whenever LISTEN connects or reconnects', async () => {
    const listener = makeListener();
    const requestCatchUp = vi.fn();
    const inbox = new PostgresProjectRevisionInbox({
      createListenClient: () => listener.client,
      requestCatchUp,
      sql: vi.fn() as unknown as Sql,
    });

    await inbox.start();
    listener.ready();
    listener.ready();

    expect(requestCatchUp).toHaveBeenCalledTimes(2);
    await inbox.stop();
  });

  test('requests an authoritative catch-up when a notification cannot be read', async () => {
    const listener = makeListener();
    const requestCatchUp = vi.fn();
    const onListenerError = vi.fn();
    const sql = vi.fn(async () => {
      throw new Error('query failed');
    }) as unknown as Sql;
    const inbox = new PostgresProjectRevisionInbox({
      createListenClient: () => listener.client,
      onListenerError,
      requestCatchUp,
      sql,
    });

    await inbox.start();
    listener.notify('notification-1');

    await vi.waitFor(() => expect(onListenerError).toHaveBeenCalledOnce());
    expect(requestCatchUp).toHaveBeenCalledOnce();
    await inbox.stop();
  });

  test('classifies a conflicting persisted notification as a permanent contract failure', async () => {
    const responses = [
      [],
      [
        {
          event_type: 'course.project-revision',
          notification_id: 'notification-1',
          payload: { projectId: 'project-1', revision: 2 },
          payload_matches: false,
          run_id: 'run-1',
          schema_version: 1,
          sequence: '1',
          user_id: 'user-1',
        },
      ],
      [],
    ];
    const transaction = Object.assign(async () => responses.shift() ?? [], {
      json: (value: unknown) => value,
    });
    const sql = Object.assign(transaction, {
      begin: async (run: (transactionSql: typeof transaction) => Promise<void>) => run(transaction),
    }) as unknown as Sql;
    const inbox = new PostgresProjectRevisionInbox({
      createListenClient: () => makeListener().client,
      sql,
    });

    await expect(
      inbox.deliver({
        attemptNumber: 1,
        eventType: 'course.project-revision',
        fencingToken: '1',
        id: 'notification-1',
        leaseExpiresAt: '2026-08-10T10:00:00.000Z',
        payload: { projectId: 'project-1', revision: 1 },
        runId: 'run-1',
        schemaVersion: 1,
        sequence: '1',
        userId: 'user-1',
        workerId: 'worker-1',
      })
    ).rejects.toMatchObject<WorkflowStepError>({
      failure: { code: 'notification_inbox_conflict', kind: 'permanent' },
    });
  });

  test('does not republish a notification already recorded by the inbox', async () => {
    const storedNotification = {
      event_type: 'course.project-revision',
      notification_id: 'notification-1',
      payload: { projectId: 'project-1', revision: 1 },
      payload_matches: true,
      run_id: 'run-1',
      schema_version: 1,
      sequence: '1',
      user_id: 'user-1',
    };
    const responses = [[], [storedNotification]];
    const queries: string[] = [];
    const transaction = Object.assign(
      async (strings: TemplateStringsArray) => {
        queries.push(strings.join('?'));
        return responses.shift() ?? [];
      },
      { json: (value: unknown) => value }
    );
    const sql = Object.assign(transaction, {
      begin: async (run: (transactionSql: typeof transaction) => Promise<void>) => run(transaction),
    }) as unknown as Sql;
    const inbox = new PostgresProjectRevisionInbox({
      createListenClient: () => makeListener().client,
      sql,
    });

    await inbox.deliver({
      attemptNumber: 2,
      eventType: 'course.project-revision',
      fencingToken: '2',
      id: 'notification-1',
      leaseExpiresAt: '2026-08-10T10:01:00.000Z',
      payload: storedNotification.payload,
      runId: 'run-1',
      schemaVersion: 1,
      sequence: '1',
      userId: 'user-1',
      workerId: 'worker-2',
    });

    expect(queries).toHaveLength(2);
    expect(queries.some(query => query.includes('pg_notify'))).toBe(false);
  });
});
