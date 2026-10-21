import { expect, test } from 'vitest';
import {
  getRequestTimings,
  measureRequestPhase,
  recordRequestTiming,
  runWithCorrelationId,
} from '../src/workflows/requestObservability.js';

test('concurrent request phase measurements remain isolated, including a failed query', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const first = runWithCorrelationId('first', async () => {
    recordRequestTiming('auth', 7);
    await pending;
    await expect(
      measureRequestPhase('query', () => Promise.reject(new Error('synthetic')))
    ).rejects.toThrow('synthetic');
    return { ...getRequestTimings() };
  });
  const second = runWithCorrelationId('second', () => {
    recordRequestTiming('auth', 11);
    release();
    return { ...getRequestTimings() };
  });
  expect(await first).toEqual({ auth: 7, query: expect.any(Number) });
  expect(second).toEqual({ auth: 11 });
  expect(getRequestTimings()).toBeUndefined();
});
