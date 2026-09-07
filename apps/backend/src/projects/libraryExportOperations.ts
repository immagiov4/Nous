import type { LibraryExportCoordinator } from './libraryExportCoordinator.js';

/** Stops awaiting non-cancellable dependencies and prevents subsequent export operations. */
export const createLibraryExportOperations = (coordinator: LibraryExportCoordinator) => {
  const controller = new AbortController();
  const { signal } = controller;
  const runStep = async <T>(operation: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await Promise.race([operation(), aborted.promise]);
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
  const runExclusively = <T>(key: string, operation: () => Promise<T>): Promise<T> =>
    runStep(() => coordinator.exclusively(key, operation));
  return { abort: () => controller.abort(), runExclusively, runStep, signal };
};
