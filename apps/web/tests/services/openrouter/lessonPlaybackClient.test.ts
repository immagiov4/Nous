// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { fetchMock, subscribe, streamListener } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  subscribe: vi.fn(),
  streamListener: { current: null as null | (() => void) },
}));
vi.mock('../../../services/projects/projectRevisionStream.ts', () => ({
  subscribeToProjectRevisionStream: subscribe,
}));
vi.mock('../../../services/auth/supabaseAuth.ts', () => ({ fetchWithSupabaseAuth: fetchMock }));
vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

import {
  cancelLessonPlaybackPreparation,
  waitForLessonPlayback,
} from '../../../services/openrouter/lessonPlaybackClient.ts';

const completed = () =>
  new Response(
    JSON.stringify({
      success: true,
      state: {
        run: {
          id: 'run',
          projectId: 'project',
          workflowId: 'prepare-lesson-playback-block',
          status: 'completed',
          cleanupStatus: 'not-required',
        },
      },
    })
  );
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  streamListener.current = null;
  subscribe.mockImplementation(({ listener }) => {
    streamListener.current = () => listener({ projectId: 'project', revision: 1 });
    return vi.fn();
  });
});
afterEach(() => vi.useRealTimers());

test.each([
  'network',
  'server',
  'json',
])('recovers an initial transient %s polling failure', async failure => {
  if (failure === 'network') fetchMock.mockRejectedValueOnce(new TypeError('Network failure'));
  else
    fetchMock.mockResolvedValueOnce(
      failure === 'server' ? new Response(null, { status: 503 }) : new Response('{')
    );
  fetchMock.mockResolvedValueOnce(completed());
  const waiting = waitForLessonPlayback('run', 'project', new AbortController().signal);
  await vi.runAllTimersAsync();
  await expect(waiting).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('propagates a definitive initial poll rejection without retrying', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(
    waitForLessonPlayback('run', 'project', new AbortController().signal)
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('cancels polling after a transient initial failure', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Network failure'));
  const controller = new AbortController();
  const waiting = waitForLessonPlayback('run', 'project', controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('a committed revision wakes playback immediately, before the one-second recovery poll', async () => {
  const running = await completed().json();
  running.state.run.status = 'running';
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify(running)))
    .mockResolvedValueOnce(completed());
  const waiting = waitForLessonPlayback('run', 'project', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledOnce();
  streamListener.current?.();
  await waiting;
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test('cancellation waits until its run releases the active key', async () => {
  const running = await completed().json();
  running.state.run.status = 'running';
  const cancelled = await completed().json();
  cancelled.state.run.status = 'cancelled';
  fetchMock
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(new Response(JSON.stringify(running)))
    .mockResolvedValueOnce(new Response(JSON.stringify(cancelled)));
  let settled = false;
  const pending = cancelLessonPlaybackPreparation('run', 'project').then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  await vi.runAllTimersAsync();
  await pending;
  expect(settled).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test.each([
  'network',
  'server',
  'json',
])('cancellation recovers its first transient %s state read', async failure => {
  fetchMock.mockResolvedValueOnce(new Response('{}'));
  if (failure === 'network') fetchMock.mockRejectedValueOnce(new TypeError('Network failure'));
  else
    fetchMock.mockResolvedValueOnce(
      failure === 'server' ? new Response(null, { status: 503 }) : new Response('{')
    );
  const cancelled = await completed().json();
  cancelled.state.run.status = 'cancelled';
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(cancelled)));
  const pending = cancelLessonPlaybackPreparation('run', 'project');
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('cancellation waits for terminal cleanup before releasing its block', async () => {
  const cleaning = await completed().json();
  cleaning.state.run.status = 'cancelled';
  cleaning.state.run.cleanupStatus = 'running';
  const cleaned = structuredClone(cleaning);
  cleaned.state.run.cleanupStatus = 'completed';
  fetchMock
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(new Response(JSON.stringify(cleaning)))
    .mockResolvedValueOnce(new Response(JSON.stringify(cleaned)));
  let settled = false;
  const pending = cancelLessonPlaybackPreparation('run', 'project').then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  await vi.runAllTimersAsync();
  await pending;
  expect(settled).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('aborts the reader wait immediately while a durable preparation is retrying', async () => {
  const running = await completed().json();
  running.state.run.status = 'running';
  fetchMock.mockResolvedValue(new Response(JSON.stringify(running)));
  const stop = vi.fn();
  subscribe.mockReturnValueOnce(stop);
  const controller = new AbortController();
  const waiting = waitForLessonPlayback('run', 'project', controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledOnce();
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetchMock).toHaveBeenCalledOnce();
});
