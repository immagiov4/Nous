import { useEffect } from 'react';
import { setAccountLocale } from '../i18n/uiMessages.ts';
import {
  isSupabaseAuthEnabled,
  readSupabaseSession,
  subscribeToSupabaseSession,
} from '../services/auth/supabaseAuth.ts';
import { loadAccountPreferences } from '../services/preferences/accountPreferences.ts';
import { useAppLocale } from './useAppLocale.ts';

export const useAccountLocale = (): void => {
  useAppLocale();
  useEffect(() => {
    if (!isSupabaseAuthEnabled()) return;
    let activeUserId: string | undefined;
    let synchronized = false;
    let loading = false;
    let disposed = false;
    const sync = () => {
      const userId = readSupabaseSession()?.user?.id;
      if (userId !== activeUserId) {
        activeUserId = userId;
        synchronized = false;
        loading = false;
        setAccountLocale(null);
      }
      if (synchronized || loading) return;
      if (!userId) return;
      loading = true;
      void loadAccountPreferences()
        .then(() => {
          if (!disposed && activeUserId === userId) synchronized = true;
        })
        .catch(error => console.error('[Nous][Account] Interface language load failed.', error))
        .finally(() => {
          if (!disposed && activeUserId === userId) loading = false;
        });
    };
    sync();
    const unsubscribe = subscribeToSupabaseSession(sync);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
};
