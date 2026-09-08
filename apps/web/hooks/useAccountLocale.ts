import { useEffect, useSyncExternalStore } from 'react';
import { getAppLocale, setAccountLocale, subscribeToAppLocale } from '../i18n/uiMessages.ts';
import {
  isSupabaseAuthEnabled,
  readSupabaseSession,
  subscribeToSupabaseSession,
} from '../services/auth/supabaseAuth.ts';
import { loadAccountPreferences } from '../services/preferences/accountPreferences.ts';

export const useAccountLocale = (): void => {
  useSyncExternalStore(subscribeToAppLocale, getAppLocale, getAppLocale);
  useEffect(() => {
    if (!isSupabaseAuthEnabled()) return;
    let activeUserId: string | undefined;
    let disposed = false;
    const sync = () => {
      const userId = readSupabaseSession()?.user?.id;
      if (userId === activeUserId) return;
      activeUserId = userId;
      setAccountLocale(null);
      if (!userId) return;
      void loadAccountPreferences()
        .then(preferences => {
          if (!disposed && activeUserId === userId) setAccountLocale(preferences.interfaceLocale);
        })
        .catch(error => console.error('[Nous][Account] Interface language load failed.', error));
    };
    sync();
    const unsubscribe = subscribeToSupabaseSession(sync);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
};
