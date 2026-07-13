import { ExternalLink, Link2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type CodexDeviceLogin,
  type CodexProviderStatus,
  cancelCodexDeviceLogin,
  loadCodexProviderStatus,
  logoutCodexProvider,
  startCodexDeviceLogin,
} from '../../services/ai/codexAccountApi.ts';

const CODEX_STATUS_POLL_MS = 2_000;

const isCodexAccessDenied = (error: unknown): boolean =>
  error instanceof Error && 'status' in error && error.status === 403;

export default function CodexConnectionSettings() {
  const [codexStatus, setCodexStatus] = useState<CodexProviderStatus | null>(null);
  const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const applyCodexStatus = useCallback((status: CodexProviderStatus) => {
    setCodexStatus(status);
    if (status.account?.type) {
      setLogin(null);
    }
  }, []);

  const refreshCodexStatus = useCallback(async () => {
    applyCodexStatus(await loadCodexProviderStatus());
  }, [applyCodexStatus]);

  useEffect(() => {
    let isActive = true;
    void loadCodexProviderStatus()
      .then(status => {
        if (isActive) {
          applyCodexStatus(status);
        }
      })
      .catch(error => {
        console.error('[Nous][Codex] Provider status failed.', error);
        if (isActive) {
          if (isCodexAccessDenied(error)) {
            applyCodexStatus({ account: null, enabled: false, models: [] });
          } else {
            setErrorMessage(t('Stato del provider AI non disponibile. Riprova.'));
          }
        }
      });
    return () => {
      isActive = false;
    };
  }, [applyCodexStatus]);

  useEffect(() => {
    if (!login) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshCodexStatus().catch(error =>
        console.error('[Nous][Codex] Login status refresh failed.', error)
      );
    }, CODEX_STATUS_POLL_MS);
    return () => window.clearInterval(interval);
  }, [login, refreshCodexStatus]);

  const handleConnect = async () => {
    setIsPending(true);
    setErrorMessage('');
    try {
      setLogin(await startCodexDeviceLogin());
    } catch (error) {
      console.error('[Nous][Codex] Login start failed.', error);
      setErrorMessage(t('Connessione a Codex non riuscita. Riprova.'));
    } finally {
      setIsPending(false);
    }
  };

  const handleCancel = async () => {
    if (!login?.loginId) {
      setLogin(null);
      return;
    }
    setIsPending(true);
    setErrorMessage('');
    try {
      await cancelCodexDeviceLogin(login.loginId);
      setLogin(null);
    } catch (error) {
      console.error('[Nous][Codex] Login cancellation failed.', error);
      setErrorMessage(t('Annullamento della connessione non riuscito. Riprova.'));
    } finally {
      setIsPending(false);
    }
  };

  const handleDisconnect = async () => {
    setIsPending(true);
    setErrorMessage('');
    try {
      await logoutCodexProvider();
      setCodexStatus(current => (current ? { ...current, account: null } : current));
    } catch (error) {
      console.error('[Nous][Codex] Logout failed.', error);
      setErrorMessage(t('Disconnessione da Codex non riuscita. Riprova.'));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <section
      aria-labelledby="codex-provider-title"
      aria-live="polite"
      aria-busy={isPending || codexStatus === null}
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <h2 id="codex-provider-title" className="flex items-center gap-2 text-sm font-semibold">
        <Link2 className="h-4 w-4" />
        Codex app-server
      </h2>

      {codexStatus?.account?.type ? (
        <div className="mt-3">
          <p className="text-sm text-gray-700">
            {codexStatus.account.email || t('Account Codex collegato')}
          </p>
          <button
            type="button"
            disabled={isPending}
            onClick={() => void handleDisconnect()}
            className="mt-3 inline-flex items-center gap-2 rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-800 disabled:opacity-60"
          >
            <Unplug className="h-4 w-4" />
            {t('Disconnetti Codex')}
          </button>
        </div>
      ) : codexStatus?.enabled === false ? (
        <p className="mt-2 text-sm leading-6 text-gray-600">
          {t('Codex è disponibile solo quando il backend locale abilita app-server.')}
        </p>
      ) : login ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-gray-700">
            {t('Apri la pagina OpenAI e inserisci questo codice:')}
          </p>
          <code className="block w-fit rounded-lg bg-gray-50 px-3 py-2 text-base font-semibold tracking-wider text-gray-950">
            {login.userCode || '—'}
          </code>
          {login.verificationUrl ? (
            <a
              href={login.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-gray-950 px-4 py-2 text-sm font-semibold text-white"
            >
              {t('Apri accesso OpenAI')}
              <ExternalLink className="h-4 w-4" />
            </a>
          ) : null}
          <button
            type="button"
            disabled={isPending}
            onClick={() => void handleCancel()}
            className="ml-2 rounded-full px-3 py-2 text-sm font-semibold text-gray-600 disabled:opacity-60"
          >
            {t('Annulla')}
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm leading-6 text-gray-600">
            {t(
              'Codex gestisce direttamente accesso, token e rinnovo. Nous non legge né salva le credenziali.'
            )}
          </p>
          <button
            type="button"
            disabled={isPending || codexStatus === null}
            onClick={() => void handleConnect()}
            className="mt-3 rounded-full bg-gray-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {t('Collega Codex')}
          </button>
        </div>
      )}

      {errorMessage ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}
