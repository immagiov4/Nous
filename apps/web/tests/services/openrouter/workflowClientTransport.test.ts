// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { TransientRequestError } from '../../../services/core/errorMessage.ts';
import {
  acquireWorkflowRequestKey,
  clearWorkflowRequestKey,
  pollWorkflow,
} from '../../../services/openrouter/workflowClientTransport.ts';

describe('workflowClientTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('keeps polling after one network disconnection', async () => {
    const readState = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce({ status: 'completed' });
    const result = pollWorkflow({
      initialState: { status: 'running' },
      isTerminal: state => state.status === 'completed',
      readState,
    });
    const assertion = expect(result).resolves.toEqual({ status: 'completed' });

    await vi.advanceTimersByTimeAsync(2_000);

    await assertion;
    expect(readState).toHaveBeenCalledTimes(2);
  });

  test('keeps polling when authentication refresh is temporarily unavailable', async () => {
    const readState = vi
      .fn()
      .mockRejectedValueOnce(new TransientRequestError('temporary auth failure'))
      .mockResolvedValueOnce({ status: 'completed' });
    const result = pollWorkflow({
      initialState: { status: 'running' },
      isTerminal: state => state.status === 'completed',
      readState,
    });
    const assertion = expect(result).resolves.toEqual({ status: 'completed' });

    await vi.advanceTimersByTimeAsync(2_000);

    await assertion;
    expect(readState).toHaveBeenCalledTimes(2);
  });

  test('does not retry a definitive polling failure', async () => {
    const readState = vi.fn().mockRejectedValue(new Error('invalid workflow response'));
    const result = pollWorkflow({
      initialState: { status: 'running' },
      isTerminal: state => state.status === 'completed',
      readState,
    });
    const assertion = expect(result).rejects.toThrow('invalid workflow response');

    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(readState).toHaveBeenCalledTimes(1);
  });

  test('a stale request handle cannot clear a newer request key', () => {
    const storageKey = 'nous:test-workflow-request';
    const first = acquireWorkflowRequestKey(storageKey);
    const stale = acquireWorkflowRequestKey(storageKey);
    first.clear();
    const replacement = acquireWorkflowRequestKey(storageKey);

    stale.clear();

    expect(replacement.requestKey).not.toBe(first.requestKey);
    expect(globalThis.sessionStorage.getItem(storageKey)).toBe(replacement.requestKey);
    replacement.clear();
    expect(globalThis.sessionStorage.getItem(storageKey)).toBeNull();
  });

  test('the explicit clear remains unconditional for terminal resume cleanup', () => {
    const storageKey = 'nous:test-workflow-request';
    acquireWorkflowRequestKey(storageKey);

    clearWorkflowRequestKey(storageKey);

    expect(globalThis.sessionStorage.getItem(storageKey)).toBeNull();
  });
});
