import {
  ACCOUNT_PREFERENCE_LIMITS,
  type AccountPreferences,
  AccountPreferencesSchema,
} from '@shared/accountPreferences';
import { ChevronDown, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import logoUrl from '@/assets/logo.svg';
import logoDarkUrl from '@/assets/logo_darkmode.svg';
import { useAppLocale } from '../../../hooks/useAppLocale.ts';
import {
  type AppLocale,
  getBrowserAppLocale,
  translateUiMessage,
  type UiMessage,
} from '../../../i18n/uiMessages.ts';
import { readInitialDarkMode } from '../../../services/preferences/documentTheme.ts';
import { Pressable } from '../../../utils/motion/index.ts';
import { SETUP_STEPS, type SetupStep } from './setupState.ts';
import { type SetupAdapter, useSetup } from './useSetup.ts';
import './setup.css';

const stepTitles: Record<SetupStep, UiMessage> = {
  languages: 'In quali lingue vuoi usare Nous?',
  preferences: 'Come preferisci ricevere le spiegazioni?',
};

function LanguageFields({
  draft,
  onChange,
  t,
}: Readonly<{
  draft: AccountPreferences;
  onChange: (patch: Partial<AccountPreferences>) => void;
  t: (message: UiMessage) => string;
}>) {
  return (
    <div className="space-y-5 text-left">
      <label className="block text-sm font-medium">
        {t('Lingua interfaccia')}
        <span className="relative block">
          <select
            className="setup-field setup-select"
            value={draft.interfaceLocale ?? ''}
            onChange={event =>
              onChange({ interfaceLocale: (event.target.value || null) as 'it' | 'en' | null })
            }
          >
            <option value="">{t('Lingua del browser')}</option>
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </select>
          <ChevronDown aria-hidden="true" className="setup-select-chevron" />
        </span>
      </label>
      <label className="block text-sm font-medium">
        {t('Lingua dei contenuti')}
        <input
          className="setup-field"
          value={draft.contentLanguage ?? ''}
          placeholder={t('Come l’interfaccia')}
          maxLength={ACCOUNT_PREFERENCE_LIMITS.CONTENT_LANGUAGE}
          onChange={event => onChange({ contentLanguage: event.target.value || null })}
        />
      </label>
    </div>
  );
}

/** The demo supplies only a different data adapter; rendering and transitions stay shared. */
export default function AccountSetupFlow({
  adapter,
  onExit,
  onThemeChange,
  browserLocale = getBrowserAppLocale(),
}: Readonly<{
  adapter: SetupAdapter;
  onExit: () => void;
  onThemeChange?: (isDarkMode: boolean) => void;
  browserLocale?: AppLocale;
}>) {
  const appLocale = useAppLocale();
  const { state, dispatch, finish } = useSetup(adapter);
  const locale = state.hasLoaded ? (state.draft.interfaceLocale ?? browserLocale) : appLocale;
  const t = (message: UiMessage) => translateUiMessage(message, undefined, locale);
  const stepLabels: Record<SetupStep, string> = {
    languages: t('Lingue'),
    preferences: t('Preferenze'),
  };
  const [isDarkMode, setDarkMode] = useState(readInitialDarkMode);
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = state.phase === 'saving';
  const nextLabel = state.step === 'preferences' ? t('Entra in Nous') : t('Continua');
  const finished = state.phase === 'completed' || state.phase === 'skipped';
  useEffect(() => {
    if (finished) onExit();
  }, [finished, onExit]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each new step must announce its heading without focusing the text input.
  useEffect(() => {
    heading.current?.focus();
  }, [state.step, finished]);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);
  const validation = AccountPreferencesSchema.safeParse({
    ...state.draft,
    contentLanguage: state.draft.contentLanguage?.trim() || null,
  });
  const change = (patch: Partial<AccountPreferences>) => dispatch({ type: 'change', patch });
  const changeStep = (step: SetupStep) => dispatch({ type: 'step', step });
  const advance = () => {
    if (!validation.success) return;
    if (state.step === 'preferences')
      void finish({ status: 'completed', preferences: validation.data });
    else changeStep(SETUP_STEPS[SETUP_STEPS.indexOf(state.step) + 1]);
  };
  const logo = isDarkMode ? logoDarkUrl : logoUrl;
  if (finished) return null;
  return (
    <div className="setup-page" lang={locale}>
      <header className="setup-header">
        <div className="flex items-center gap-2 sm:gap-3">
          <img src={logo} alt="" className="h-8 w-8" />
          <span className="font-serif text-2xl">Nous</span>
        </div>
        <div className="flex items-center gap-3 sm:gap-6">
          <Pressable
            type="button"
            onClick={() => {
              const next = !isDarkMode;
              setDarkMode(next);
              onThemeChange?.(next);
            }}
            aria-label={isDarkMode ? t('Usa tema chiaro') : t('Usa tema scuro')}
            className="rounded-full p-2 text-stone-600 hover:bg-stone-200 dark:text-stone-300 dark:hover:bg-white/5"
          >
            {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Pressable>
          <button
            type="button"
            className="setup-link"
            disabled={busy}
            onClick={() => void finish({ status: 'skipped' })}
          >
            {t('Salta per ora')}
          </button>
        </div>
      </header>
      <nav aria-label={t('Configurazione iniziale')} className="setup-progress">
        <ol>
          {SETUP_STEPS.map(step => (
            <li key={step} aria-current={state.step === step ? 'step' : undefined}>
              {stepLabels[step]}
            </li>
          ))}
        </ol>
      </nav>
      <main className="setup-main">
        <img src={logo} alt="" className="setup-owl" />
        <h1 ref={heading} tabIndex={-1} className="setup-title">
          {t(stepTitles[state.step])}
        </h1>
        <p className="setup-subtitle">
          {t('Puoi aggiungere o cambiare queste indicazioni nelle impostazioni, anche più avanti.')}
        </p>
        {state.phase === 'loading' && <output>{t('Caricamento preferenze...')}</output>}
        {(state.phase === 'load-error' || state.phase === 'save-error') && (
          <p role="alert" className="mt-6 text-sm text-red-700 dark:text-red-300">
            {t('Preferenze non disponibili. Riprova.')}
            {!state.hasLoaded && (
              <button
                className="ml-2 underline"
                type="button"
                onClick={() => dispatch({ type: 'reload' })}
              >
                {t('Riprova')}
              </button>
            )}
          </p>
        )}
        {state.hasLoaded && (
          <form
            key={state.step}
            className="setup-form"
            onSubmit={event => {
              event.preventDefault();
              advance();
            }}
          >
            <fieldset disabled={busy}>
              {state.step === 'languages' && (
                <LanguageFields draft={state.draft} onChange={change} t={t} />
              )}
              {state.step === 'preferences' && (
                <textarea
                  className="setup-field setup-textarea"
                  aria-label={t('Preferenze didattiche')}
                  placeholder={t(
                    'Per esempio: ho difficoltà con la matematica. Spiega ogni simbolo e mostra tutti i passaggi.'
                  )}
                  value={state.draft.teachingPreferences}
                  maxLength={ACCOUNT_PREFERENCE_LIMITS.TEACHING_PREFERENCES}
                  onChange={event => change({ teachingPreferences: event.target.value })}
                />
              )}
              <button
                type="submit"
                className="setup-primary"
                disabled={busy || !validation.success}
                aria-busy={busy}
              >
                {busy ? t('Salvataggio…') : nextLabel}
              </button>
              {state.step !== 'languages' && (
                <button
                  className="setup-back setup-link"
                  type="button"
                  onClick={() => changeStep(SETUP_STEPS[SETUP_STEPS.indexOf(state.step) - 1])}
                >
                  {t('Indietro')}
                </button>
              )}
            </fieldset>
          </form>
        )}
      </main>
    </div>
  );
}
