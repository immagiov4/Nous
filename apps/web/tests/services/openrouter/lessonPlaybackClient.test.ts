// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/auth/supabaseAuth.ts', () => ({ fetchWithSupabaseAuth: fetchMock }));
vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

import { waitForLessonPlayback } from '../../../services/openrouter/lessonPlaybackClient.ts';

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
