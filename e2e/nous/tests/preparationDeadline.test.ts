import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FreshnessEvidence } from '../freshness';
import {
  ACCOUNT_CLEANUP_STEP,
  FRESH_CONTENT_PREPARATION_TIMEOUT_MS,
  PREPARATION_TIMEOUT_CODE,
  PreparationDeadline,
} from '../preparationDeadline';
import type { StackStatus } from '../stack';

let deadline: PreparationDeadline;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  const evidence: FreshnessEvidence = {
    userId: 'account',
    storyId: 'story',
    viewport: 'desktop',
    requestKey: 'request',
    workflowId: 'workflow',
    projectId: 'project',
    sectionId: 'lesson',
    outcome: 'current',
    warnings: [],
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
  deadline = new PreparationDeadline(
    evidence,
    {} as StackStatus,
    Object.assign(new Error(PREPARATION_TIMEOUT_CODE), { code: PREPARATION_TIMEOUT_CODE })
  );
});
afterEach(() => {
  deadline.finish();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('aborts an in-flight file write at the approved deadline and force-closes owned connections', async () => {
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<void>();
  const connection = { end: vi.fn(async () => {}) };
  deadline.ownConnection(connection);
  let signal: AbortSignal | undefined;
  const pending = deadline.step(
    'evidence-file-write',
    current => {
      signal = current;
      entered.resolve();
      return late.promise;
    },
    'write'
  );
  const blocked = expect(pending).rejects.toMatchObject({ code: PREPARATION_TIMEOUT_CODE });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
  await blocked;
  expect(signal?.aborted).toBe(true);
  expect(connection.end).toHaveBeenCalledWith({ timeout: 0 });
  expect(deadline.evidence).toMatchObject({
    outcome: 'blocked',
    errorCode: PREPARATION_TIMEOUT_CODE,
    durationMs: FRESH_CONTENT_PREPARATION_TIMEOUT_MS,
  });
  expect(deadline.steps).toContainEqual({
    name: 'evidence-file-write',
    kind: 'write',
    status: 'incomplete',
  });
  deadline.freeze();
  const frozen = structuredClone(deadline.evidence);
  late.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(deadline.evidence).toEqual(frozen);
});

it('lists pending cleanup resources and freezes a late cleanup failure', async () => {
  const late = Promise.withResolvers<void>();
  const connection = { end: vi.fn(async () => {}) };
  deadline.ownConnection(connection, true);
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
  await deadline.settle(ACCOUNT_CLEANUP_STEP, () => late.promise, 'cleanup');
  deadline.freeze();
  expect(deadline.evidence.preparation?.possiblyLeakedResources).toEqual([
    { accountId: 'account', projectId: 'project' },
  ]);
  expect(connection.end).toHaveBeenCalledWith({ timeout: 0 });
  const frozen = structuredClone(deadline.evidence);
  late.reject(Object.assign(new Error('Cleanup failed'), { code: 'cleanup-failed' }));
  await Promise.resolve();
  await Promise.resolve();
  expect(deadline.evidence).toEqual(frozen);
});

it.each([
  'completed',
  'failed',
] as const)('records detached cleanup that %s before finalization', async status => {
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
  await deadline.settle(
    ACCOUNT_CLEANUP_STEP,
    async () => {
      if (status === 'failed')
        throw Object.assign(new Error('Cleanup failed'), { code: 'cleanup-failed' });
    },
    'cleanup'
  );
  await vi.waitFor(() =>
    expect(deadline.steps.find(step => step.name === ACCOUNT_CLEANUP_STEP)?.status).toBe(status)
  );
  deadline.freeze();
  expect(deadline.evidence.preparation?.possiblyLeakedResources).toEqual(
    status === 'completed' ? [] : [{ accountId: 'account', projectId: 'project' }]
  );
});

it('attempts a final immutable file write without waiting beyond expiry and records it as incomplete', async () => {
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
  const late = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  await deadline.settle(
    'final-evidence-write',
    current => {
      signal = current;
      return late.promise;
    },
    'write'
  );
  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(false);
  expect(deadline.steps).toContainEqual({
    name: 'final-evidence-write',
    kind: 'write',
    status: 'incomplete',
  });
  deadline.freeze();
  const frozen = structuredClone(deadline.evidence);
  late.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(deadline.evidence).toEqual(frozen);
});
