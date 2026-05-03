// fallow-ignore-file unused-exports — used by readerShellProps

import { useEffect, useState } from 'react';
import {
  getSyncState,
  onSyncStateChange,
  type SyncState,
} from '../../services/projects/syncState.ts';

export interface SyncIndicatorState {
  syncState: SyncState;
}

export const useSyncIndicator = (): SyncIndicatorState => {
  const [syncState, setSyncState] = useState<SyncState>(() => getSyncState());

  useEffect(() => onSyncStateChange(setSyncState), []);

  return { syncState };
};
