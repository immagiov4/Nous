import { afterEach, expect, test, vi } from 'vitest';
import { boundedRender, ownRendererLaunch } from '../atlas/execution';

afterEach(() => vi.useRealTimers());

test('successful captures cancel the supervisor without terminating the renderer', async () => {
  vi.useFakeTimers();
  const terminate = vi.fn();
  await expect(
    boundedRender(async () => 'captured', { milliseconds: 100, terminate })
  ).resolves.toBe('captured');
  await vi.runAllTimersAsync();
  expect(terminate).not.toHaveBeenCalled();
});

test('expiration awaits process termination and suppresses late capture results', async () => {
  vi.useFakeTimers();
  let finishCapture!: (value: string) => void;
  let finishTermination!: () => void;
  const terminate = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finishTermination = resolve;
      })
  );
  const result = boundedRender(
    () =>
      new Promise<string>(resolve => {
        finishCapture = resolve;
      }),
    { milliseconds: 100, terminate }
  );
  const outcome = result.catch(error => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(terminate).toHaveBeenCalledOnce();
  finishCapture('late result');
  let settled = false;
  void outcome.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finishTermination();
  expect(await outcome).toBeInstanceOf(Error);
  expect((await outcome).message).toContain('exceeded 100 ms');
  expect(vi.getTimerCount()).toBe(0);
});

test('cancellation retains a pending launch and waits for the late server to terminate', async () => {
  let finishLaunch!: (server: { kill(): Promise<void> }) => void;
  let finishKill!: () => void;
  const kill = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finishKill = resolve;
      })
  );
  const owner = ownRendererLaunch(
    new Promise<{ kill(): Promise<void> }>(resolve => {
      finishLaunch = resolve;
    })
  );
  const readiness = owner.ready.catch(error => error);
  let terminated = false;
  const termination = owner.terminate().then(() => {
    terminated = true;
  });
  finishLaunch({ kill });
  expect(await readiness).toBeInstanceOf(Error);
  expect(kill).toHaveBeenCalledOnce();
  expect(terminated).toBe(false);
  finishKill();
  await termination;
  expect(terminated).toBe(true);
});

test('launch failures remain visible without fabricating a process to terminate', async () => {
  const failure = new Error('Launch failed');
  const owner = ownRendererLaunch(Promise.reject(failure));
  await expect(owner.ready).rejects.toBe(failure);
  await expect(owner.terminate()).resolves.toBeUndefined();
});
