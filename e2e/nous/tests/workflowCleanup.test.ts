import { setTimeout as delay } from 'node:timers/promises';
import type { Sql } from 'postgres';
import { afterEach, expect, it, vi } from 'vitest';
import { PostgresWorkflowCancellationStore } from '../../../apps/backend/src/workflows/postgresWorkflowCancellationStore';
import { STACK_SHUTDOWN_GRACE_MS } from '../stack';
import { settleAccountWorkflows } from '../workflowCleanup';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('waits past cancellation acknowledgement and undo completion for every account run', async () => {
  const ticks: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  vi.mocked(delay).mockImplementation(() => {
    const tick = Promise.withResolvers<void>();
    ticks.push(tick);
    return tick.promise;
  });
  const active = {
    id: 'ui-run',
    active: true,
    cancellation_requested: false,
    workers_running: true,
    cleanup_status: 'not-required',
  };
  const sibling = { ...active, id: 'preparation-run' };
  const rows = [active, sibling];
  const query = vi.fn(async () => rows);
  const request = vi
    .spyOn(PostgresWorkflowCancellationStore.prototype, 'request')
    .mockImplementation(async ({ runId }) => {
      const run = rows.find(row => row.id === runId);
      if (!run) throw new Error('Foreign account run');
      run.cancellation_requested = true;
      return { status: 'requested', runStatus: 'running' };
    });
  let finished = false;
  const pending = settleAccountWorkflows(query as unknown as Sql, 'account').then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(ticks).toHaveLength(1));
  expect(request.mock.calls.map(([input]) => input)).toEqual([
    { runId: 'ui-run', userId: 'account' },
    { runId: 'preparation-run', userId: 'account' },
  ]);
  expect(finished).toBe(false);
  Object.assign(active, { active: false, workers_running: false, cleanup_status: 'pending' });
  Object.assign(sibling, { active: false, workers_running: false });
  ticks[0].resolve();
  await vi.waitFor(() => expect(ticks).toHaveLength(2));
  expect(finished).toBe(false);
  Object.assign(active, { cleanup_status: 'running', workers_running: true });
  ticks[1].resolve();
  await vi.waitFor(() => expect(ticks).toHaveLength(3));
  expect(finished).toBe(false);
  Object.assign(active, { cleanup_status: 'completed', workers_running: false });
  ticks[2].resolve();
  await pending;
  expect(finished).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});
it('rejects failed compensation and aborts a pending retirement', async () => {
  const failed = vi.fn(async () => [{ cleanup_status: 'failed' }]);
  await expect(settleAccountWorkflows(failed as unknown as Sql, 'account')).rejects.toThrow(
    'compensation failed'
  );
  const controller = new AbortController();
  const running = Object.assign(
    vi.fn(async () => [
      { id: 'run', active: true, cancellation_requested: true, cleanup_status: 'not-required' },
    ]),
    { end: vi.fn(async () => {}) }
  );
  const pending = settleAccountWorkflows(running as unknown as Sql, 'account', controller.signal);
  const rejection = expect(pending).rejects.toThrow();
  controller.abort();
  await rejection;
  expect(running.end).toHaveBeenCalledWith({ timeout: 0 });
});

it.each([
  'select',
  'cancellation',
  'worker',
  'compensation',
  'close-failure',
])('bounds ordinary retirement stalled at %s and releases its connection', async stage => {
  vi.useFakeTimers();
  const blocked = Promise.withResolvers<never>();
  const closeError = new Error('Connection close failed');
  const rows = [
    {
      id: 'run',
      active: stage === 'cancellation',
      cancellation_requested: false,
      workers_running: stage === 'worker',
      cleanup_status: stage === 'compensation' ? 'pending' : 'not-required',
    },
  ];
  const sql = Object.assign(
    vi.fn(() =>
      ['select', 'close-failure'].includes(stage) ? blocked.promise : Promise.resolve(rows)
    ),
    {
      end: vi.fn(async () => {
        blocked.reject(new Error('Connection destroyed'));
        if (stage === 'close-failure') throw closeError;
      }),
    }
  );
  vi.spyOn(PostgresWorkflowCancellationStore.prototype, 'request').mockImplementation(
    () => blocked.promise
  );
  vi.mocked(delay).mockImplementation(() => blocked.promise);
  let outcome: unknown;
  const pending = settleAccountWorkflows(sql as unknown as Sql, 'account').catch(error => {
    outcome = error;
  });
  await vi.advanceTimersByTimeAsync(STACK_SHUTDOWN_GRACE_MS - 1);
  expect(outcome).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  if (stage === 'close-failure') {
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('retirement timed out') }),
      closeError,
    ]);
  } else
    expect(outcome).toMatchObject({ message: expect.stringContaining('retirement timed out') });
  expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
  expect(vi.getTimerCount()).toBe(0);
});
