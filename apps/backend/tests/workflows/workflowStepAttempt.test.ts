import { afterEach, expect, test, vi } from 'vitest';
import { startWorkflowAttemptMonitor } from '../../src/workflows/workflowStepAttempt.js';

afterEach(() => vi.useRealTimers());

test.each([
  'lost',
  'exception',
] as const)('safely interrupts a %s heartbeat retaining technical metadata', async outcome => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const heartbeat = vi.fn(async () => {
    if (outcome === 'lost') return { status: 'lost' as const };
    throw Object.assign(new Error('private prompt password=hidden'), {
      code: 'ECONNRESET',
      prompt: 'private prompt',
    });
  });
  const monitor = startWorkflowAttemptMonitor({
    controller,
    heartbeat,
    heartbeatIntervalMs: 20,
    interruptionError: status => new Error(status),
    leaseMs: 60,
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(controller.signal.aborted).toBe(true);
  expect(await monitor.stop()).toEqual(
    outcome === 'lost'
      ? 'lost'
      : {
          status: 'heartbeat-failed',
          diagnostic: { type: 'Error', code: 'ECONNRESET' },
        }
  );
  if (outcome === 'exception')
    expect(controller.signal.reason.cause).toEqual({ type: 'Error', code: 'ECONNRESET' });
  await vi.advanceTimersByTimeAsync(60);
  expect(heartbeat).toHaveBeenCalledOnce();
});
