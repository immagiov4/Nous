import { afterEach, expect, test, vi } from 'vitest';
import {
  createModelCallObserver,
  markModelCallPhase,
  withModelCallDiagnostics,
} from '../../src/workflows/modelCallDiagnostics.js';
import { toWorkflowErrorDiagnostic } from '../../src/workflows/workflowErrorDiagnostics.js';

afterEach(() => vi.useRealTimers());

test('freezes phase and timings at abort even when provider work continues', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const observer = createModelCallObserver();
  let release = () => {};
  const pending = observer
    .run(() =>
      withModelCallDiagnostics(controller.signal, async () => {
        markModelCallPhase('awaiting-output');
        await new Promise<void>(resolve => {
          release = resolve;
        });
        markModelCallPhase('completed');
        throw new Error('PRIVATE_OUTPUT');
      })
    )
    .catch(error => error);
  await vi.advanceTimersByTimeAsync(25);
  controller.abort();
  const interrupted = observer.snapshot();
  await vi.advanceTimersByTimeAsync(75);
  release();
  const error = await pending;
  expect(interrupted).toMatchObject({
    phase: 'awaiting-output',
    elapsedMs: 25,
    phaseElapsedMs: 25,
    durationsMs: { initializing: 0, 'awaiting-output': 25 },
  });
  expect(observer.snapshot()).toEqual(interrupted);
  expect(toWorkflowErrorDiagnostic(error, { includeContent: false })).toEqual({
    type: 'Error',
    modelCall: interrupted,
  });
});

test('keeps concurrent attempts separate and records completed local processing', async () => {
  const first = createModelCallObserver();
  const second = createModelCallObserver();
  let release = () => {};
  const pending = first.run(() =>
    withModelCallDiagnostics(undefined, async () => {
      markModelCallPhase('awaiting-ack');
      await new Promise<void>(resolve => {
        release = resolve;
      });
      markModelCallPhase('completed');
      markModelCallPhase('post-processing');
    })
  );
  await second.run(() =>
    withModelCallDiagnostics(undefined, async () => {
      markModelCallPhase('awaiting-output');
    })
  );
  expect(first.snapshot()?.phase).toBe('awaiting-ack');
  expect(second.snapshot()?.phase).toBe('awaiting-output');
  release();
  await pending;
  expect(first.snapshot()?.phase).toBe('post-processing');
  expect(second.snapshot()?.phase).toBe('awaiting-output');
});

test('nested provider adapters keep the parent call phase and elapsed time', async () => {
  vi.useFakeTimers();
  const observer = createModelCallObserver();
  await observer.run(() =>
    withModelCallDiagnostics(undefined, async () => {
      markModelCallPhase('awaiting-ack');
      await vi.advanceTimersByTimeAsync(10);
      await withModelCallDiagnostics(undefined, async () => {
        markModelCallPhase('receiving-output');
        await vi.advanceTimersByTimeAsync(5);
      });
    })
  );
  expect(observer.snapshot()).toMatchObject({
    phase: 'receiving-output',
    elapsedMs: 15,
    durationsMs: { 'awaiting-ack': 10, 'receiving-output': 5 },
  });
});
