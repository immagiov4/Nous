import { afterEach, expect, test, vi } from 'vitest';
import { boundedRender } from '../atlas/execution';

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
