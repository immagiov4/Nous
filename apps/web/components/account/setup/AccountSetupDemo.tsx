import { EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences';
import { useEffect, useMemo, useState } from 'react';
import { useAppLocale } from '../../../hooks/useAppLocale.ts';
import { setAccountLocale, translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import AccountSetupFlow from './AccountSetupFlow.tsx';
import type { SetupAdapter } from './useSetup.ts';

type Scenario = 'empty' | 'saved' | 'load-error' | 'save-error' | 'loading' | 'saving';

function createDemoAdapter(scenario: Scenario) {
  let release: (() => void) | undefined;
  const hold = () =>
    new Promise<void>(resolve => {
      release = resolve;
    });
  const preferences =
    scenario === 'saved'
      ? {
          interfaceLocale: 'it' as const,
          contentLanguage: '日本語',
          teachingPreferences: t('Spiega ogni simbolo e mostra tutti i passaggi.'),
        }
      : { ...EMPTY_ACCOUNT_PREFERENCES };
  let failLoad = scenario === 'load-error';
  let failSave = scenario === 'save-error';
  const adapter: SetupAdapter = {
    async load() {
      if (scenario === 'loading') await hold();
      if (failLoad) {
        throw new Error('Simulated load failure');
      }
      return { ...preferences };
    },
    async finish() {
      if (scenario === 'saving') await hold();
      if (failSave) {
        throw new Error('Simulated save failure');
      }
    },
  };
  return {
    adapter,
    release: () => {
      failLoad = false;
      failSave = false;
      release?.();
    },
  };
}

/** Developer-only entry: no authentication, API client, or persistent writes. */
export default function AccountSetupDemo() {
  useAppLocale();
  const scenarios: Record<Scenario, string> = {
    empty: t('Campi vuoti'),
    saved: t('Preferenze esistenti'),
    'load-error': t('Errore di caricamento'),
    'save-error': t('Errore di salvataggio'),
    loading: t('Caricamento sospeso'),
    saving: t('Salvataggio sospeso'),
  };
  const [configuration, setConfiguration] = useState({
    scenario: 'empty' as Scenario,
    revision: 0,
  });
  const { scenario, revision } = configuration;
  const restart = () =>
    setConfiguration(current => ({ ...current, revision: current.revision + 1 }));
  const [locale, setLocale] = useState<'it' | 'en'>('it');
  const demo = useMemo(() => createDemoAdapter(configuration.scenario), [configuration]);
  useEffect(() => {
    setAccountLocale(locale);
    return () => setAccountLocale(null);
  }, [locale]);
  return (
    <>
      <AccountSetupFlow
        key={`${scenario}-${revision}`}
        adapter={demo.adapter}
        browserLocale={locale}
        onExit={restart}
      />
      <aside
        aria-label={t('Controlli dimostrazione')}
        className="flex flex-wrap items-center justify-center gap-4 border-t border-stone-300 bg-stone-100 p-4 text-sm text-stone-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <span>{t('Dimostrazione locale · dati finti')}</span>
        <label>
          {t('Scenario')}{' '}
          <select
            className="bg-transparent"
            value={scenario}
            onChange={event =>
              setConfiguration(current => ({
                scenario: event.target.value as Scenario,
                revision: current.revision + 1,
              }))
            }
          >
            {Object.entries(scenarios).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Lingua')}{' '}
          <select
            className="bg-transparent"
            value={locale}
            onChange={event => setLocale(event.target.value as 'it' | 'en')}
          >
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </select>
        </label>
        <button type="button" onClick={demo.release}>
          {t('Sblocca operazione o errore')}
        </button>
        <button type="button" onClick={restart}>
          {t('Ricomincia')}
        </button>
      </aside>
    </>
  );
}
