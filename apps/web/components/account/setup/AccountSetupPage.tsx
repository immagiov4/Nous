import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { useAppLocale } from '../../../hooks/useAppLocale.ts';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import {
  readSupabaseSession,
  subscribeToSupabaseSession,
} from '../../../services/auth/supabaseAuth.ts';
import { loadAccountPreferences } from '../../../services/preferences/accountPreferences.ts';
import {
  ACCOUNT_SETUP_PATH,
  finishAccountSetup,
  loadAccountSetupStatus,
} from '../../../services/preferences/accountSetup.ts';
import {
  readUiPreferences,
  UI_PREFERENCES_KEY,
} from '../../../services/preferences/uiPreferencesStorage.ts';
import { normalizePathname } from '../../../utils/pathname.ts';
import AccountSetupFlow from './AccountSetupFlow.tsx';

const adapter = { load: loadAccountPreferences, finish: finishAccountSetup };
const enterApp = () => {
  globalThis.location.assign('/');
};
const persistTheme = (isDarkMode: boolean) => {
  try {
    localStorage.setItem(
      UI_PREFERENCES_KEY,
      JSON.stringify({ ...readUiPreferences(localStorage), isDarkMode })
    );
  } catch (error) {
    console.error('[Nous][Setup] Theme persistence failed.', error);
  }
};
export default function AccountSetupPage() {
  return <AccountSetupFlow adapter={adapter} onExit={enterApp} onThemeChange={persistTheme} />;
}

function SetupStatusGate({ children }: Readonly<{ children: ReactNode }>) {
  const [status, setStatus] = useState<'loading' | 'pending' | 'ready' | 'error'>('loading');
  useEffect(() => {
    if (status !== 'loading') return;
    let active = true;
    void loadAccountSetupStatus()
      .then(result => {
        if (active) setStatus(result === 'pending' ? 'pending' : 'ready');
      })
      .catch(error => {
        console.error('[Nous][Setup] Status unavailable.', error);
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [status]);
  if (status === 'ready') return children;
  if (status === 'pending') return <AccountSetupPage />;
  return (
    <main className="setup-page flex flex-col items-center justify-center gap-6">
      <output role={status === 'error' ? 'alert' : undefined}>
        {t(
          status === 'error' ? 'Preferenze non disponibili. Riprova.' : 'Caricamento preferenze...'
        )}
      </output>
      {status === 'error' && (
        <>
          <button onClick={() => setStatus('loading')} type="button">
            {t('Riprova')}
          </button>
          <button onClick={() => setStatus('ready')} type="button">
            {t('Entra in Nous')}
          </button>
        </>
      )}
    </main>
  );
}

/** A changed account remounts the gate and discards the previous account's draft. */
export function AccountSetupGate({ children }: Readonly<{ children: ReactNode }>) {
  useAppLocale();
  const accountId = useSyncExternalStore(
    subscribeToSupabaseSession,
    () => readSupabaseSession()?.user?.id ?? null,
    () => null
  );
  if (!accountId) return children;
  if (normalizePathname(globalThis.location.pathname) === ACCOUNT_SETUP_PATH)
    return <AccountSetupPage key={accountId} />;
  return <SetupStatusGate key={accountId}>{children}</SetupStatusGate>;
}
