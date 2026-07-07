// fallow-ignore-file unused-exports — used by readerShellProps

import { useSyncExternalStore } from 'react';
import {
  getSyncState,
  onSyncStateChange,
  type SyncState,
} from '../../services/projects/syncState.ts';

export interface SyncIndicatorState {
  syncState: SyncState;
}

export const useSyncIndicator = (): SyncIndicatorState => {
  const syncState = useSyncExternalStore(onSyncStateChange, getSyncState, getSyncState);

  return { syncState };
};
