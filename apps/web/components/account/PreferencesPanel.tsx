import type { AccountPreferences } from '@shared/accountPreferences';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { getAppLocale, translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  clearAccountPreferences,
  loadAccountPreferences,
  saveAccountPreferences,
} from '../../services/preferences/accountPreferences.ts';

const fieldClassName =
  'mt-2 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-950 outline-none focus:border-stone-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-400';

export default function PreferencesPanel() {
  const [saved, setSaved] = useState<AccountPreferences | null>(null);
  const [draft, setDraft] = useState<AccountPreferences | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef(false);
  const load = useCallback(() => {
    void loadAccountPreferences()
      .then(preferences => {
        if (!active.current) return;
        setSaved(preferences);
        setDraft(preferences);
      })
      .catch(error => {
        console.error('[Nous][Account] Preferences load failed.', error);
        if (active.current) setError(true);
      });
  }, []);
  useEffect(() => {
    active.current = true;
    load();
    return () => {
      active.current = false;
    };
  }, [load]);

  const persist = async (clear: boolean) => {
    if (!draft || pending) return;
    setPending(true);
    setError(false);
    try {
      const preferences = await (clear
        ? clearAccountPreferences()
        : saveAccountPreferences({
            ...draft,
            contentLanguage: draft.contentLanguage?.trim() || null,
          }));
      if (!active.current) return;
      setSaved(preferences);
      setDraft(preferences);
    } catch (error) {
      console.error('[Nous][Account] Preferences save failed.', error);
      if (active.current) setError(true);
    } finally {
      if (active.current) setPending(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void persist(false);
  };
  const changed = JSON.stringify(saved) !== JSON.stringify(draft);

  return (
    <div className="space-y-5">
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {t('Preferenze non disponibili. Riprova.')}
          {!draft ? (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                setError(false);
                load();
              }}
            >
              {t('Riprova')}
            </button>
          ) : null}
        </p>
      ) : null}
      {draft ? (
        <form onSubmit={onSubmit} className="space-y-5">
          <fieldset disabled={pending} className="space-y-5">
            <label className="block text-sm font-medium">
              {t('Lingua interfaccia')}
              <select
                className={fieldClassName}
                value={draft.interfaceLocale ?? getAppLocale()}
                onChange={event =>
                  setDraft({ ...draft, interfaceLocale: event.target.value as 'it' | 'en' })
                }
              >
                <option value="it">Italiano</option>
                <option value="en">English</option>
              </select>
            </label>
            <div>
              <label className="block text-sm font-medium">
                {t('Lingua IA')}
                <input
                  className={fieldClassName}
                  value={draft.contentLanguage ?? ''}
                  placeholder={t('Come l’interfaccia')}
                  aria-describedby="content-language-help"
                  onChange={event =>
                    setDraft({ ...draft, contentLanguage: event.target.value || null })
                  }
                />
              </label>
              <p
                id="content-language-help"
                className="mt-2 text-xs leading-5 text-stone-500 dark:text-zinc-400"
              >
                {t(
                  'Usata nella chat generale e come lingua iniziale dei nuovi corsi. Lascia vuoto per seguire l’interfaccia; puoi cambiarla per un singolo corso.'
                )}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium">
                {t('Preferenze didattiche')}{' '}
                <span className="font-normal text-stone-500 dark:text-zinc-400">
                  {t('(facoltative)')}
                </span>
                <textarea
                  rows={5}
                  className={`${fieldClassName} resize-y`}
                  value={draft.teachingPreferences}
                  aria-describedby="teaching-preferences-help"
                  onChange={event =>
                    setDraft({ ...draft, teachingPreferences: event.target.value })
                  }
                />
              </label>
              <p
                id="teaching-preferences-help"
                className="mt-2 text-xs leading-5 text-stone-500 dark:text-zinc-400"
              >
                {t(
                  'Descrivi come preferisci ricevere spiegazioni o le tue necessità di accessibilità. Queste indicazioni valgono come punto di partenza per nuovi corsi: puoi modificarle durante l’intervista. I corsi esistenti non cambiano.'
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-stone-200 pt-4 dark:border-zinc-700">
              <button
                type="submit"
                disabled={pending || !changed}
                aria-busy={pending}
                className="rounded-full bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950"
              >
                {t('Salva preferenze')}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void persist(true)}
                className="rounded-full px-4 py-2.5 text-sm text-stone-600 disabled:opacity-50 dark:text-zinc-300"
              >
                {t('Cancella preferenze salvate')}
              </button>
            </div>
          </fieldset>
        </form>
      ) : !error ? (
        <output className="text-sm text-stone-500">{t('Caricamento preferenze...')}</output>
      ) : null}
    </div>
  );
}
