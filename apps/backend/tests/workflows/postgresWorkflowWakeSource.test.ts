import { describe, expect, test, vi } from 'vitest';

import {
  PostgresWorkflowWakeSource,
  type WorkflowListenClient,
} from '../../src/workflows/postgresWorkflowWakeSource.js';

interface ListenRegistration {
  channel: string;
  notify: (payload: string) => void;
  ready: () => void;
}

const makeClient = () => {
  const registrations: ListenRegistration[] = [];
  const end = vi.fn(async () => undefined);
  const client: WorkflowListenClient = {
    end,
    listen: vi.fn(async (channel, notify, ready) => {
      registrations.push({ channel, notify, ready: ready ?? (() => undefined) });
      return { unlisten: vi.fn(async () => undefined) };
    }),
  };
  return { client, createClient: vi.fn(() => client), end, registrations };
};

describe('PostgreSQL workflow wake source', () => {
  test('maps existing channels and rescans everything on connect or reconnect', async () => {
    const { createClient, end, registrations } = makeClient();
    const wakes: string[] = [];
    const subscription = await new PostgresWorkflowWakeSource(createClient).subscribe(wake => {
      wakes.push(wake);
    });

    expect(registrations.map(registration => registration.channel)).toEqual([
      'workflow_ready',
      'workflow_undo_ready',
      'workflow_notification_ready',
      'workflow_cleanup',
    ]);
    registrations[0]?.notify('run-1');
    registrations[1]?.notify('run-2');
    registrations[2]?.notify('run-3');
    registrations[3]?.notify('run-4');
    registrations[0]?.ready();

    expect(wakes).toEqual(['step', 'undo', 'notification', 'cancellation-reconciliation', 'all']);

    await Promise.all([subscription.unsubscribe(), subscription.unsubscribe()]);
    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith({ timeout: 0 });
  });

  test('removes earlier listeners when a later channel cannot subscribe', async () => {
    const firstUnlisten = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    let calls = 0;
    const client: WorkflowListenClient = {
      end,
      listen: vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error('listen failed');
        return { unlisten: firstUnlisten };
      }),
    };

    await expect(new PostgresWorkflowWakeSource(() => client).subscribe(vi.fn())).rejects.toThrow(
      'listen failed'
    );
    expect(firstUnlisten).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledWith({ timeout: 0 });
  });

  test('allows teardown to be retried after a transient close failure', async () => {
    const { client, createClient } = makeClient();
    const end = vi
      .fn()
      .mockRejectedValueOnce(new Error('close failed'))
      .mockResolvedValueOnce(undefined);
    client.end = end;
    const subscription = await new PostgresWorkflowWakeSource(createClient).subscribe(vi.fn());

    await expect(subscription.unsubscribe()).rejects.toThrow('close failed');
    await expect(subscription.unsubscribe()).resolves.toBeUndefined();

    expect(end).toHaveBeenCalledTimes(2);
  });
});
