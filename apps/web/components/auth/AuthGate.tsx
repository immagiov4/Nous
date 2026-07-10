import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  consumeSupabaseSessionFromUrl,
  getValidSupabaseSession,
  isLocalAuthBypassEnabled,
  isSupabaseAuthEnabled,
  readSupabaseSession,
  refreshSupabaseSession,
  SUPABASE_SESSION_REFRESH_RETRY_MS,
  type SupabaseUserSession,
  scheduleSupabaseSessionRefresh,
  sendMagicLink,
  signInWithPassword,
  subscribeToSupabaseSession,
} from '../../services/auth/supabaseAuth.ts';
import LandingPage from '../marketing/LandingPage.tsx';

interface AuthGateProps {
  children: ReactNode;
}

type AuthStatus = 'idle' | 'loading' | 'magic-link-sent' | 'error';

const LoginPanel = ({
  onAuthenticated,
}: {
  onAuthenticated: (session: SupabaseUserSession) => void;
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<AuthStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handlePasswordLogin = async (event: FormEvent) => {
    event.preventDefault();
    setStatus('loading');
    setErrorMessage('');

    try {
      onAuthenticated(await signInWithPassword({ email, password }));
      setStatus('idle');
    } catch {
      setStatus('error');
      setErrorMessage(t('Accesso non riuscito.'));
    }
  };

  const handleMagicLink = async () => {
    setStatus('loading');
    setErrorMessage('');

    try {
      await sendMagicLink(email);
      setStatus('magic-link-sent');
    } catch {
      setStatus('error');
      setErrorMessage(t('Invio magic link non riuscito.'));
    }
  };

  return (
    <div className="marketing-login-panel">
      <p className="text-sm leading-6 text-gray-600">
        {t('Accedi al tuo spazio di studio per sincronizzare corsi, note e progressi.')}
      </p>

      <form className="mt-6 space-y-4" onSubmit={handlePasswordLogin}>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
            Email
          </span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none focus:border-gray-900"
            required
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
            Password
          </span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none focus:border-gray-900"
          />
        </label>

        {errorMessage ? <p className="text-sm text-red-600">{errorMessage}</p> : null}
        {status === 'magic-link-sent' ? (
          <p className="text-sm text-gray-600">
            {t('Magic link inviato. Controlla la tua email.')}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="submit"
            disabled={status === 'loading'}
            className="inline-flex flex-1 items-center justify-center rounded-full bg-gray-950 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {t('Accedi')}
          </button>
          <button
            type="button"
            disabled={!email || status === 'loading'}
            onClick={handleMagicLink}
            className="inline-flex flex-1 items-center justify-center rounded-full border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-800 disabled:opacity-50"
          >
            Magic link
          </button>
        </div>
      </form>
    </div>
  );
};

export default function AuthGate({ children }: AuthGateProps) {
  const [session, setSession] = useState<SupabaseUserSession | null>(() =>
    isSupabaseAuthEnabled()
      ? readSupabaseSession()
      : isLocalAuthBypassEnabled()
        ? { accessToken: 'local-bypass' }
        : null
  );

  useEffect(() => {
    if (!isSupabaseAuthEnabled()) {
      return;
    }

    let isActive = true;
    let cancelScheduledRefresh = () => {};

    const scheduleSynchronizationRetry = () => {
      cancelScheduledRefresh();
      const retryId = globalThis.setTimeout(() => {
        void synchronizeSession();
      }, SUPABASE_SESSION_REFRESH_RETRY_MS);
      cancelScheduledRefresh = () => globalThis.clearTimeout(retryId);
    };

    const applySession = (nextSession: SupabaseUserSession | null) => {
      if (!isActive) {
        return;
      }

      cancelScheduledRefresh();
      setSession(nextSession);
      cancelScheduledRefresh = nextSession
        ? scheduleSupabaseSessionRefresh(nextSession, async () => {
            try {
              applySession(await refreshSupabaseSession());
            } catch {
              scheduleSynchronizationRetry();
            }
          })
        : () => {};
    };

    const synchronizeSession = async () => {
      try {
        consumeSupabaseSessionFromUrl();
        applySession(await getValidSupabaseSession());
      } catch {
        scheduleSynchronizationRetry();
      }
    };

    const unsubscribe = subscribeToSupabaseSession(nextSession => {
      applySession(nextSession);
      if (nextSession?.refreshToken) {
        void synchronizeSession();
      }
    });
    queueMicrotask(() => {
      void synchronizeSession();
    });

    return () => {
      isActive = false;
      cancelScheduledRefresh();
      unsubscribe();
    };
  }, []);

  if (isLocalAuthBypassEnabled() || session) {
    return <>{children}</>;
  }

  if (!isSupabaseAuthEnabled()) {
    return (
      <LandingPage
        loginPanel={
          <div className="marketing-login-panel">
            <p className="text-sm leading-6 text-gray-600">
              {t(
                'Autenticazione non configurata. Imposta VITE_AUTH_MODE=supabase e collega Supabase per accedere alla libreria server.'
              )}
            </p>
          </div>
        }
      />
    );
  }

  return <LandingPage loginPanel={<LoginPanel onAuthenticated={setSession} />} />;
}
