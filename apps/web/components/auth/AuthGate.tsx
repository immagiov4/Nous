import { type ReactNode, type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  completeSupabasePasswordSetup,
  consumeSupabaseAuthCallbackFromUrl,
  getValidSupabaseSession,
  isLocalAuthBypassEnabled,
  isSupabaseAuthEnabled,
  readSupabaseAuthCallbackFromUrl,
  readSupabaseSession,
  refreshSupabaseSession,
  SUPABASE_SESSION_REFRESH_RETRY_MS,
  SupabasePasswordSetupError,
  type SupabaseUserSession,
  scheduleSupabaseSessionRefresh,
  sendMagicLink,
  sendPasswordRecovery,
  signInWithPassword,
  subscribeToSupabaseSession,
} from '../../services/auth/supabaseAuth.ts';
import { clearAllDurableLessonRequests } from '../../services/openrouter/lessonGenerationClient.ts';
import LandingPage from '../marketing/LandingPage.tsx';

interface AuthGateProps {
  readonly children: ReactNode;
}

type AuthStatus = 'idle' | 'loading' | 'magic-link-sent' | 'recovery-sent' | 'error';

const PasswordSetupPanel = ({
  action,
  onSessionExpired,
}: {
  readonly action: 'invite' | 'recovery';
  readonly onSessionExpired: () => void;
}) => {
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const savePassword = async () => {
    setErrorMessage('');
    if (password !== passwordConfirmation) {
      setErrorMessage(t('Le password non coincidono.'));
      return;
    }

    setIsSaving(true);
    try {
      await completeSupabasePasswordSetup(password);
    } catch (error) {
      if (error instanceof SupabasePasswordSetupError && error.reason === 'expired') {
        onSessionExpired();
        return;
      }
      if (error instanceof SupabasePasswordSetupError && error.reason === 'weak-password') {
        setErrorMessage(t('La password è troppo debole. Scegline una più lunga e difficile.'));
        setIsSaving(false);
        return;
      }
      setErrorMessage(t('Non è stato possibile salvare la password. Riprova tra poco.'));
      setIsSaving(false);
    }
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void savePassword();
  };

  const isAccountSetup = action === 'invite';
  let submitLabel = isAccountSetup ? t('Imposta password ed entra') : t('Salva la nuova password');
  if (isSaving) {
    submitLabel = t('Salvataggio…');
  }

  return (
    <div className="marketing-login-panel">
      <h2 className="font-serif text-2xl text-gray-950">
        {t(isAccountSetup ? 'Completa il tuo account' : 'Scegli una nuova password')}
      </h2>
      <p className="mt-3 text-sm leading-6 text-gray-600">
        {t(
          isAccountSetup
            ? 'Il link ha confermato il tuo indirizzo email. Scegli una password per completare l’account e continuare.'
            : 'Il link di recupero ti ha autenticato. La password cambierà solo quando confermi quella nuova.'
        )}
      </p>

      <form className="mt-6 space-y-4" onSubmit={handleSubmit} aria-busy={isSaving}>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
            {t('Nuova password')}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none focus:border-gray-900"
            required
          />
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
            {t('Conferma password')}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={passwordConfirmation}
            onChange={event => setPasswordConfirmation(event.target.value)}
            className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none focus:border-gray-900"
            required
          />
        </label>

        {errorMessage ? (
          <p role="alert" className="text-sm text-red-600">
            {errorMessage}
          </p>
        ) : null}
        {isSaving ? <output className="sr-only">{t('Salvataggio…')}</output> : null}

        <button
          type="submit"
          disabled={isSaving}
          className="inline-flex w-full items-center justify-center rounded-full bg-gray-950 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </form>
    </div>
  );
};

const LoginPanel = ({
  callbackError,
  onAuthenticated,
}: {
  readonly callbackError?: boolean;
  readonly onAuthenticated: (session: SupabaseUserSession) => void;
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<AuthStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const signIn = async () => {
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

  const handlePasswordLogin = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void signIn();
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

  const handlePasswordRecovery = async () => {
    setStatus('loading');
    setErrorMessage('');

    try {
      await sendPasswordRecovery(email);
      setStatus('recovery-sent');
    } catch {
      setStatus('error');
      setErrorMessage(t('Richiesta di recupero non riuscita. Riprova.'));
    }
  };

  return (
    <div className="marketing-login-panel">
      <p className="text-sm leading-6 text-gray-600">
        {t('Accedi al tuo spazio di studio per sincronizzare corsi, note e progressi.')}
      </p>
      {callbackError ? (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {t('Il link non è valido o è scaduto. Richiedine uno nuovo.')}
        </p>
      ) : null}

      <form
        className="mt-6 space-y-4"
        onSubmit={handlePasswordLogin}
        aria-busy={status === 'loading'}
      >
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

        <button
          type="button"
          disabled={!email || status === 'loading'}
          onClick={handlePasswordRecovery}
          className="text-sm font-semibold text-gray-600 underline-offset-4 hover:underline disabled:opacity-50"
        >
          {t('Password dimenticata?')}
        </button>

        {errorMessage ? (
          <p role="alert" className="text-sm text-red-600">
            {errorMessage}
          </p>
        ) : null}
        {status === 'magic-link-sent' ? (
          <output className="block text-sm text-gray-600">
            {t('Se esiste un account per questa email, riceverai un link di accesso.')}
          </output>
        ) : null}
        {status === 'recovery-sent' ? (
          <output className="block text-sm text-gray-600">
            {t(
              'Se esiste un account per questa email, riceverai un link per scegliere una nuova password.'
            )}
          </output>
        ) : null}
        {status === 'loading' ? (
          <output className="block text-sm text-gray-600">{t('Operazione in corso…')}</output>
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

interface AuthGateState {
  callbackError: boolean;
  session: SupabaseUserSession | null;
}

const readInitialAuthGateState = (): AuthGateState => {
  if (isSupabaseAuthEnabled()) {
    const callback = readSupabaseAuthCallbackFromUrl();
    return {
      callbackError: callback.status === 'error',
      session: callback.session,
    };
  }

  return {
    callbackError: false,
    session: isLocalAuthBypassEnabled() ? { accessToken: 'local-bypass' } : null,
  };
};

export default function AuthGate({ children }: AuthGateProps) {
  const [initialPreviousSession] = useState(() =>
    isSupabaseAuthEnabled() ? readSupabaseSession() : null
  );
  const [authState, setAuthState] = useState<AuthGateState>(readInitialAuthGateState);
  const { callbackError, session } = authState;
  const previousSessionRef = useRef(initialPreviousSession);

  useEffect(() => {
    const previousSession = previousSessionRef.current;
    const previousUserId = previousSession?.user?.id;
    const currentUserId = session?.user?.id;
    const sessionBoundary = previousSession === null || session === null;
    const accountChanged =
      previousUserId !== undefined &&
      currentUserId !== undefined &&
      previousUserId !== currentUserId;
    if (isSupabaseAuthEnabled() && (sessionBoundary || accountChanged)) {
      clearAllDurableLessonRequests();
    }
    previousSessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!isSupabaseAuthEnabled()) {
      return;
    }

    let isActive = true;
    let cancelScheduledRefresh = () => {};

    const scheduleSynchronizationRetry = () => {
      cancelScheduledRefresh();
      const retryId = globalThis.window.setTimeout(() => {
        void synchronizeSession();
      }, SUPABASE_SESSION_REFRESH_RETRY_MS);
      cancelScheduledRefresh = () => globalThis.window.clearTimeout(retryId);
    };

    const applySession = (nextSession: SupabaseUserSession | null) => {
      if (!isActive) {
        return;
      }

      cancelScheduledRefresh();
      setAuthState(current => ({ ...current, session: nextSession }));
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
        const callback = consumeSupabaseAuthCallbackFromUrl();
        if (callback.status === 'error') {
          if (!isActive) {
            return;
          }
          cancelScheduledRefresh();
          setAuthState({ callbackError: true, session: null });
          return;
        }
        applySession(await getValidSupabaseSession());
      } catch {
        scheduleSynchronizationRetry();
      }
    };

    const unsubscribe = subscribeToSupabaseSession(nextSession => {
      applySession(nextSession);
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

  const shouldShowPublicLanding = globalThis.window?.location.pathname === '/landing';

  if (shouldShowPublicLanding) {
    return (
      <LandingPage
        loginInitiallyOpen={callbackError}
        loginPanel={
          <LoginPanel
            callbackError={callbackError}
            onAuthenticated={nextSession =>
              setAuthState({ callbackError: false, session: nextSession })
            }
          />
        }
      />
    );
  }

  const passwordSetupAction = session?.user?.passwordSetupRequired ? 'invite' : session?.authAction;

  if (!isLocalAuthBypassEnabled() && passwordSetupAction) {
    return (
      <LandingPage
        loginInitiallyOpen
        loginPanel={
          <PasswordSetupPanel
            action={passwordSetupAction}
            onSessionExpired={() => setAuthState({ callbackError: true, session: null })}
          />
        }
      />
    );
  }

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

  return (
    <LandingPage
      loginInitiallyOpen={callbackError}
      loginPanel={
        <LoginPanel
          callbackError={callbackError}
          onAuthenticated={nextSession =>
            setAuthState({ callbackError: false, session: nextSession })
          }
        />
      }
    />
  );
}
