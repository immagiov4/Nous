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
import {
  type AiProviderPreference,
  getAiProviderPreference,
  setAiProviderPreference,
} from '../../services/ai/providerPreference.ts';

type ProviderSelection = AiProviderPreference | 'default';

const CODEX_STATUS_POLL_MS = 2_000;

const isCodexAccessDenied = (error: unknown): boolean =>
  error instanceof Error && 'status' in error && error.status === 403;

export default function AiProviderSettings() {
  const [provider, setProvider] = useState<ProviderSelection>(
    () => getAiProviderPreference() || 'default'
  );
  const [codexStatus, setCodexStatus] = useState<CodexProviderStatus | null>(null);
  const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const applyCodexStatus = useCallback((status: CodexProviderStatus) => {
    setCodexStatus(status);
    if (status.account?.type) {
      setLogin(null);
    }
    if (!status.enabled) {
      setProvider(current => (current === 'codex' ? 'default' : current));
      if (getAiProviderPreference() === 'codex') {
        setAiProviderPreference(null);
      }
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

  const handleProviderChange = (nextProvider: ProviderSelection) => {
    setProvider(nextProvider);
    setAiProviderPreference(nextProvider === 'default' ? null : nextProvider);
  };

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
      if (provider === 'codex') {
        handleProviderChange('default');
      }
    } catch (error) {
      console.error('[Nous][Codex] Logout failed.', error);
      setErrorMessage(t('Disconnessione da Codex non riuscita. Riprova.'));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="mt-5 space-y-5">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-zinc-200">
          {t('Provider AI per le attività testuali')}
          <select
            value={provider}
            aria-describedby="ai-provider-help"
            onChange={event => handleProviderChange(event.target.value as ProviderSelection)}
            className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none focus:border-gray-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            <option value="default">{t('Predefinito del servizio')}</option>
            <option value="openrouter">OpenRouter</option>
            <option value="openai">OpenAI API</option>
            <option value="codex" disabled={codexStatus?.enabled === false}>
              Codex
            </option>
          </select>
        </label>
        <p
          id="ai-provider-help"
          className="mt-2 text-xs leading-5 text-gray-500 dark:text-zinc-400"
        >
          {t(
            'La scelta riguarda lezioni, pianificazione e chat. Modelli e livelli di ragionamento restano configurati dall’amministratore.'
          )}
        </p>
      </div>

      <section
        aria-labelledby="codex-provider-title"
        aria-live="polite"
        aria-busy={isPending || codexStatus === null}
        className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/60"
      >
        <h3
          id="codex-provider-title"
          className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-zinc-100"
        >
          <Link2 className="h-4 w-4" />
          Codex app-server
        </h3>

        {codexStatus?.account?.type ? (
          <div className="mt-3">
            <p className="text-sm text-gray-700 dark:text-zinc-200">
              {codexStatus.account.email || t('Account Codex collegato')}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-zinc-400">
              {[codexStatus.account.type, codexStatus.account.planType].filter(Boolean).join(' · ')}
            </p>
            <button
              type="button"
              disabled={isPending}
              onClick={() => void handleDisconnect()}
              className="mt-3 inline-flex items-center gap-2 rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-800 disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-100"
            >
              <Unplug className="h-4 w-4" />
              {t('Disconnetti Codex')}
            </button>
          </div>
        ) : codexStatus?.enabled === false ? (
          <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-zinc-300">
            {t('Codex è disponibile solo quando il backend locale abilita app-server.')}
          </p>
        ) : login ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-gray-700 dark:text-zinc-200">
              {t('Apri la pagina OpenAI e inserisci questo codice:')}
            </p>
            <code className="block w-fit rounded-lg bg-white px-3 py-2 text-base font-semibold tracking-wider text-gray-950 dark:bg-zinc-950 dark:text-zinc-100">
              {login.userCode || '—'}
            </code>
            {login.verificationUrl ? (
              <a
                href={login.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-gray-950 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950"
              >
                {t('Apri accesso OpenAI')}
                <ExternalLink className="h-4 w-4" />
              </a>
            ) : null}
            <button
              type="button"
              disabled={isPending}
              onClick={() => void handleCancel()}
              className="ml-2 rounded-full px-3 py-2 text-sm font-semibold text-gray-600 disabled:opacity-60 dark:text-zinc-300"
            >
              {t('Annulla')}
            </button>
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-sm leading-6 text-gray-600 dark:text-zinc-300">
              {t(
                'Codex gestisce direttamente accesso, token e rinnovo. Nous non legge né salva le credenziali.'
              )}
            </p>
            <button
              type="button"
              disabled={isPending || codexStatus === null}
              onClick={() => void handleConnect()}
              className="mt-3 rounded-full bg-gray-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950"
            >
              {t('Collega Codex')}
            </button>
          </div>
        )}
      </section>

      {errorMessage ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-300">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
