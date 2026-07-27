/**
 * syncState — lightweight observable for sync-state indicator.
 *
 * Auto-clears to 'saved' after AUTO_CLEAR_MS to prevent stuck indicators
 * when a markSyncSaved/markSyncError call is lost (e.g. network hang, race).
 */

export type SyncState = 'saved' | 'saving' | 'error';

type SyncStateListener = (state: SyncState) => void;

let currentState: SyncState = 'saved';
const listeners = new Set<SyncStateListener>();

const AUTO_CLEAR_MS = 2_000;
let autoClearTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleAutoClear = () => {
  if (autoClearTimer) clearTimeout(autoClearTimer);
  autoClearTimer = setTimeout(() => {
    setSyncState('saved');
    autoClearTimer = null;
  }, AUTO_CLEAR_MS);
};

const cancelAutoClear = () => {
  if (autoClearTimer) {
    clearTimeout(autoClearTimer);
    autoClearTimer = null;
  }
};

export const setSyncState = (state: SyncState): void => {
  if (currentState === state) return;
  currentState = state;
  listeners.forEach(fn => {
    fn(state);
  });
};

export const getSyncState = (): SyncState => currentState;

export const onSyncStateChange = (fn: SyncStateListener): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/**
 * Mark sync as "saving". Auto-clears after AUTO_CLEAR_MS as a safety net.
 */
export const markSyncSaving = (): void => {
  setSyncState('saving');
  scheduleAutoClear();
};

/**
 * Mark sync as errored. Auto-clears after AUTO_CLEAR_MS.
 */
export const markSyncError = (): void => {
  setSyncState('error');
  scheduleAutoClear();
};

/**
 * Mark sync as saved. Cancels the auto-clear, goes green immediately.
 */
export const markSyncSaved = (): void => {
  cancelAutoClear();
  setSyncState('saved');
};
