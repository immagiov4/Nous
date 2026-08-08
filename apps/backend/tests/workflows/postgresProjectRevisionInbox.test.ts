import type { Sql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { PostgresProjectRevisionInbox } from '../../src/workflows/postgresProjectRevisionInbox.js';
import type { WorkflowListenClient } from '../../src/workflows/postgresWorkflowWakeSource.js';

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
});
