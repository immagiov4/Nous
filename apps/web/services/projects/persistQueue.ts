// fallow-ignore-file unused-exports — consumed by httpProjectRepository

/**
 * persistQueue — FIFO queue for granular persistence operations.
 *
 * - Dedup by key so that rapid highlight/note edits coalesce into one PATCH.
 * - Exponential backoff on failure (max 3 retries).
 * - Drain on unmount via `flush()`.
 * - Notifies callbacks on success/failure for sync-state tracking.
 */

import { getSupabaseAuthHeaders } from '../auth/supabaseAuth.ts';
import { getErrorMessage } from '../core/errorMessage.ts';

export type PatchOperation = {
  /** Dedup key — if a queued operation with the same key exists, the old one is replaced. */
  key: string;
  /** The PATCH body to send. */
  body: Record<string, unknown>;
  /** The project ID to PATCH. */
  projectId: string;
  /** Called on successful persistence. */
  onSuccess?: () => void;
  /** Called if all retries are exhausted. */
  onError?: (error: Error) => void;
};

type QueuedItem = PatchOperation & {
  retryCount: number;
  scheduledAt: number;
};

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_QUEUE_SIZE = 200;
const FLUSH_TIMEOUT_MS = 5_000;

let queue: QueuedItem[] = [];
let processing = false;
let flushPromise: Promise<void> | null = null;
let flushResolve: (() => void) | null = null;

const getBackendUrl = (): string => {
  // Inline minimal config access to avoid circular dependencies.
  const serverConfig = (globalThis as Record<string, unknown>).__NOUS_SERVER_CONFIG__ as
    | { backendUrl?: string }
    | undefined;
  return serverConfig?.backendUrl || 'http://localhost:3301';
};

const buildPatchUrl = (projectId: string): string =>
  `${getBackendUrl()}/api/projects/projects/${encodeURIComponent(projectId)}`;

const sendPatch = async (item: QueuedItem): Promise<void> => {
  const response = await fetch(buildPatchUrl(item.projectId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getSupabaseAuthHeaders() },
    body: JSON.stringify({ patch: item.body }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || response.statusText || 'Patch failed');
  }
};

const processQueue = async (): Promise<void> => {
  if (processing) return;
  processing = true;

  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      try {
        await sendPatch(item);
        item.onSuccess?.();
      } catch (error) {
        if (item.retryCount < MAX_RETRIES) {
          const delay = INITIAL_RETRY_DELAY_MS * 2 ** item.retryCount;
          item.retryCount++;
          await new Promise<void>(resolve => {
            setTimeout(resolve, delay);
          });
          // Re-push to front for retry (after delay)
          queue.unshift(item);
          // Continue the loop — next iteration will retry
          continue;
        }

        item.onError?.(error instanceof Error ? error : new Error(getErrorMessage(error)));
      }
    }
  } finally {
    processing = false;
    flushResolve?.();
    flushResolve = null;
    flushPromise = null;
  }

  // If new items were added while we were finishing, restart
  if (queue.length > 0 && !processing) {
    void processQueue();
  }
};

/**
 * Enqueue a patch operation. If an operation with the same key already exists
 * in the queue (not yet sent), the existing one is replaced — latest wins.
 */
export const enqueuePatch = (operation: PatchOperation): void => {
  if (queue.length >= MAX_QUEUE_SIZE) {
    console.warn('[persistQueue] Queue full, dropping oldest item');
    queue.shift();
  }

  // Dedup: find existing item with same key and replace it
  const existingIndex = queue.findIndex(item => item.key === operation.key);
  const newItem: QueuedItem = {
    ...operation,
    retryCount: 0,
    scheduledAt: Date.now(),
  };

  if (existingIndex >= 0) {
    queue[existingIndex] = newItem;
  } else {
    queue.push(newItem);
  }

  void processQueue();
};

/**
 * Flush all pending operations. Returns when the queue is empty or timeout elapses.
 */
export const flush = async (timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> => {
  if (queue.length === 0) return;

  if (!flushPromise) {
    flushPromise = new Promise<void>(resolve => {
      flushResolve = resolve;
    });
  }

  // Trigger processing if idle
  void processQueue();

  await Promise.race([flushPromise, new Promise<void>(resolve => setTimeout(resolve, timeoutMs))]);
};

/**
 * Returns the number of pending operations.
 */
export const pendingCount = (): number => queue.length;

/**
 * Clear all pending operations without executing them.
 */
export const clear = (): void => {
  queue = [];
};

/**
 * Returns current queue stats for sync state indicator.
 */
export const getQueueState = (): { pending: number; retrying: number } => ({
  pending: queue.filter(item => item.retryCount === 0).length,
  retrying: queue.filter(item => item.retryCount > 0).length,
});
