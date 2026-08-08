import { describe, expect, test, vi } from 'vitest';
import { closeBackendResources } from '../src/backendShutdown.ts';

describe('closeBackendResources', () => {
  test('closes every resource even when an earlier cleanup fails', async () => {
    const workflowFailure = new Error('worker stop failed');
    const stopFeedback = vi.fn();
    const closeCodex = vi.fn(async () => undefined);
    const closeWorkflow = vi.fn(async () => {
      throw workflowFailure;
    });
    const closeHttpServer = vi.fn(async () => undefined);

    await expect(
      closeBackendResources({ closeCodex, closeHttpServer, closeWorkflow, stopFeedback })
    ).rejects.toMatchObject({ errors: [workflowFailure] });

    expect(stopFeedback).toHaveBeenCalledOnce();
    expect(closeCodex).toHaveBeenCalledOnce();
    expect(closeWorkflow).toHaveBeenCalledOnce();
    expect(closeHttpServer).toHaveBeenCalledOnce();
  });
});
