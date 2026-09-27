/** Projects a captured lesson off the UI thread; cancellation terminates its computation. */
export const projectSelectionContent = async (content: string, signal: AbortSignal) => {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./selectionProjection.worker.ts', import.meta.url), {
    type: 'module',
  });
  let abort!: () => void;
  try {
    return await new Promise<string>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = (event: MessageEvent<string>) => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessageerror = () => reject(new Error('Invalid selection projection response'));
      worker.postMessage(content);
    });
  } finally {
    signal.removeEventListener('abort', abort);
    worker.terminate();
  }
};
