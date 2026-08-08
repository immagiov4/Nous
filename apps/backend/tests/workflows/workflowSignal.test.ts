import { describe, expect, test } from 'vitest';
import { decideWorkflowSignalReplay } from '../../src/workflows/postgresWorkflowSignalStore.js';
import { WorkflowSignalError } from '../../src/workflows/workflowErrors.js';

describe('workflow signal request identity', () => {
  const requested = {
    requestPayload: { approved: true, nested: { reason: 'ready' } },
    signalType: 'approve',
    waitId: '6d8ef677-3af5-44ef-a064-1577a6769133',
  };

  test('accepts a new request and recognizes an exact replay independent of object key order', () => {
    expect(decideWorkflowSignalReplay(null, requested)).toBe('new');
    expect(
      decideWorkflowSignalReplay(
        {
          requestPayload: { nested: { reason: 'ready' }, approved: true },
          signalType: 'approve',
          waitId: requested.waitId,
        },
        requested
      )
    ).toBe('replayed');
  });

  test.each([
    [{ ...requested, waitId: '6f13674f-0fb5-4c43-a4e9-420d042b31aa' }],
    [{ ...requested, signalType: 'reject' }],
    [{ ...requested, requestPayload: { approved: false } }],
  ])('rejects reuse of the request key for a different signal', existing => {
    expect(() => decideWorkflowSignalReplay(existing, requested)).toThrow(WorkflowSignalError);
  });
});
