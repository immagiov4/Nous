import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  executeWorkflowCheckpointWithRetry,
  isTransientPostgresCheckpointError,
} from '../../src/workflows/workflowCheckpointRetry.js';

const databaseError = (code: string): Error & { code: string } =>
  Object.assign(new Error(`Database error ${code}`), { code });

describe('workflow checkpoint retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test.each([
    '40001',
    '40P01',
    '08006',
    '57P03',
    'CONNECTION_CLOSED',
    'ECONNRESET',
  ])('classifies %s as transient', code => {
    expect(isTransientPostgresCheckpointError(databaseError(code))).toBe(true);
  });

  test.each([
    '23505',
    '40002',
    '42P01',
    '28000',
    '08P01',
    'CONNECTION_ENDED',
  ])('does not retry permanent PostgreSQL or driver error %s', code => {
    expect(isTransientPostgresCheckpointError(databaseError(code))).toBe(false);
  });

  test('paces persistent transient failures with operational backoff and remains abortable', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const interruption = new Error('lease lost');
    let calls = 0;
    const operation = async (): Promise<never> => {
      calls += 1;
      throw databaseError('40001');
    };
    const execution = executeWorkflowCheckpointWithRetry(operation, controller.signal, {
      random: () => 0,
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    controller.abort(interruption);

    await expect(execution).rejects.toBe(interruption);
  });
});
