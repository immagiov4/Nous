import { describe, expect, test, vi } from 'vitest';
import { closeBackendResources } from '../src/backendShutdown.ts';

describe('closeBackendResources', () => {
  test('starts closing HTTP before awaiting a pending export cleanup', async () => {
    const exportsClosed = Promise.withResolvers<void>();
    const closeHttpServer = vi.fn(async () => undefined);
    const closeLibraryExports = vi.fn(() => exportsClosed.promise);
    const closing = closeBackendResources({
      closeAccountStore: vi.fn(async () => undefined),
      closeHttpServer,
      closeLibraryExports,
      closeCodex: vi.fn(async () => undefined),
      closeWorkflow: vi.fn(async () => undefined),
      stopFeedback: vi.fn(),
    });
    try {
      await vi.waitFor(() => expect(closeLibraryExports).toHaveBeenCalledOnce());
      expect(closeHttpServer).toHaveBeenCalledOnce();
    } finally {
      exportsClosed.resolve();
      await closing;
    }
  });

  test('closes every resource even when an earlier cleanup fails', async () => {
    const workflowFailure = new Error('worker stop failed');
    const stopFeedback = vi.fn();
    const closeCodex = vi.fn(async () => undefined);
    const closeWorkflow = vi.fn(async () => {
      throw workflowFailure;
    });
    const closeHttpServer = vi.fn(async () => undefined);
    const closeLibraryExports = vi.fn(async () => undefined);
    const closeAccountStore = vi.fn(async () => undefined);

    await expect(
      closeBackendResources({
        closeAccountStore,
        closeCodex,
        closeHttpServer,
        closeLibraryExports,
        closeWorkflow,
        stopFeedback,
      })
    ).rejects.toMatchObject({ errors: [workflowFailure] });

    expect(stopFeedback).toHaveBeenCalledOnce();
    expect(closeCodex).toHaveBeenCalledOnce();
    expect(closeWorkflow).toHaveBeenCalledOnce();
    expect(closeHttpServer).toHaveBeenCalledOnce();
    expect(closeLibraryExports).toHaveBeenCalledOnce();
    expect(closeAccountStore).toHaveBeenCalledOnce();
  });
});
