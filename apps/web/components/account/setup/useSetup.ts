import type { AccountPreferences } from '@shared/accountPreferences';
import type { FinishAccountSetup } from '@shared/accountSetup';
import { useEffect, useReducer, useRef } from 'react';
import { initialSetupState, setupReducer } from './setupState.ts';

export interface SetupAdapter {
  load(): Promise<AccountPreferences>;
  finish(result: FinishAccountSetup): Promise<void>;
}

export function useSetup(adapter: SetupAdapter) {
  const [state, dispatch] = useReducer(setupReducer, initialSetupState);
  const active = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (state.phase !== 'loading') return;
    let disposed = false;
    void adapter
      .load()
      .then(preferences => {
        if (!disposed) dispatch({ type: 'loaded', preferences });
      })
      .catch(error => {
        console.error('[Nous][Setup] Preferences load failed.', error);
        if (!disposed) dispatch({ type: 'load-failed' });
      });
    return () => {
      disposed = true;
    };
  }, [adapter, state.phase]);

  const finish = async (result: FinishAccountSetup) => {
    if (pending.current) return;
    pending.current = true;
    dispatch({ type: 'saving' });
    try {
      await adapter.finish(result);
      if (active.current) dispatch({ type: result.status });
    } catch (error) {
      console.error('[Nous][Setup] Completion failed.', error);
      if (active.current) dispatch({ type: 'save-failed' });
    } finally {
      pending.current = false;
    }
  };
  return { state, dispatch, finish };
}
