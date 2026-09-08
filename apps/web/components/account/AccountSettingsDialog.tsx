import { Database, Download, Languages, ShieldCheck, Upload, X } from 'lucide-react';
import { type ChangeEvent, type SubmitEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  isPasswordAccount,
  requestSupabaseEmailChange,
  type SupabaseAccount,
  sendPasswordRecovery,
  updateSupabasePassword,
} from '../../services/auth/supabaseAuth.ts';
import { LibraryArchiveError } from '../../services/projects/libraryArchive.ts';
import { reportLibraryArchiveImportFailure } from '../../services/projects/libraryArchiveDiagnostics.ts';
import type { LibraryExportProgressListener } from '../../services/projects/projectRepository.ts';
import PreferencesPanel from './PreferencesPanel.tsx';

export type AccountSection = 'preferences' | 'data' | 'security';

const categoryClassName =
  'flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm text-stone-600 aria-[current=page]:bg-stone-200 aria-[current=page]:text-stone-950 dark:text-zinc-300 dark:aria-[current=page]:bg-zinc-800 dark:aria-[current=page]:text-white';
type AccountAction = 'backup-export' | 'backup-import' | 'email' | 'password' | 'recovery';

const SUCCESS_MESSAGE_DURATION_MS = 3_000;

interface AccountPanelProps {
  readonly account: SupabaseAccount;
  readonly initialSection: AccountSection;
  readonly onAccountChange: (account: SupabaseAccount) => void;
  readonly onClose: () => void;
  readonly onExportLibraryBackup?: (onProgress?: LibraryExportProgressListener) => Promise<number>;
  readonly onImportLibraryBackup?: (file: File) => Promise<number>;
}

const fieldClassName =
  'mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none focus:border-gray-900 disabled:bg-gray-100 disabled:text-gray-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-400';
const secondaryActionClassName =
  'inline-flex min-h-10 items-center justify-center rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-800 transition-[background-color,border-color,color,transform] duration-150 hover:border-stone-400 hover:bg-stone-100 active:scale-[0.97] disabled:cursor-wait disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500 dark:hover:bg-zinc-800';

const getLibraryExportLabel = (
  isExporting: boolean,
  progress: Parameters<LibraryExportProgressListener>[0] | null
): string => {
  if (!isExporting) return t('Esporta tutti i corsi');
  if (!progress) return t('Esportazione in corso...');
  return t('Esportazione {completed} di {total}...', {
    completed: progress.completedProjectCount,
    total: progress.projectCount,
  });
};

export default function AccountSettingsDialog({
  account,
  initialSection,
  onAccountChange,
  onClose,
  onExportLibraryBackup,
  onImportLibraryBackup,
}: AccountPanelProps) {
  const [activeSection, setActiveSection] = useState<AccountSection>(initialSection);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pendingAction, setPendingAction] = useState<AccountAction | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [libraryExportProgress, setLibraryExportProgress] = useState<
    Parameters<LibraryExportProgressListener>[0] | null
  >(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const passwordAccount = isPasswordAccount(account);

  useEffect(() => {
    titleRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
        ) ?? []
      ).filter(control => !control.matches(':disabled') && !control.closest('[hidden], .hidden'));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && (index === -1 || index === controls.length - 1)) {
        event.preventDefault();
        controls[0]?.focus();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  useEffect(() => {
    if (!successMessage) {
      return;
    }

    const timeout = globalThis.window.setTimeout(
      () => setSuccessMessage(''),
      SUCCESS_MESSAGE_DURATION_MS
    );
    return () => globalThis.window.clearTimeout(timeout);
  }, [successMessage]);

  const beginAction = (action: AccountAction) => {
    setPendingAction(action);
    setErrorMessage('');
    setSuccessMessage('');
  };

  const handleEmailChange = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newEmail.trim()) {
      return;
    }
    beginAction('email');
    try {
      const nextAccount = await requestSupabaseEmailChange(newEmail);
      onAccountChange(nextAccount);
      setNewEmail('');
      setSuccessMessage(t('Controlla la posta per confermare il nuovo indirizzo email.'));
    } catch (error) {
      console.error('[Nous][Account] Email update failed.', error);
      setErrorMessage(t('Cambio email non riuscito. Riprova.'));
    } finally {
      setPendingAction(null);
    }
  };

  const handlePasswordChange = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newPassword) {
      return;
    }
    beginAction('password');
    try {
      const nextAccount = await updateSupabasePassword(newPassword);
      onAccountChange(nextAccount);
      setNewPassword('');
      setSuccessMessage(t('Password aggiornata.'));
    } catch (error) {
      console.error('[Nous][Account] Password update failed.', error);
      setErrorMessage(t('Cambio password non riuscito. Riprova.'));
    } finally {
      setPendingAction(null);
    }
  };

  const handleRecovery = async () => {
    if (!account.email) {
      return;
    }
    beginAction('recovery');
    try {
      await sendPasswordRecovery(account.email);
      setSuccessMessage(t('Email di recupero inviata.'));
    } catch (error) {
      console.error('[Nous][Account] Password recovery failed.', error);
      setErrorMessage(t('Invio email di recupero non riuscito. Riprova.'));
    } finally {
      setPendingAction(null);
    }
  };

  const handleBackupExport = async () => {
    if (!onExportLibraryBackup) return;
    beginAction('backup-export');
    try {
      const courseCount = await onExportLibraryBackup(setLibraryExportProgress);
      setSuccessMessage(
        t('Richiesta di scaricamento del backup di {courseCount} corsi inviata.', { courseCount })
      );
    } catch (error) {
      console.error('[Nous][Account] Library backup export failed.', error);
      setErrorMessage(t('Esportazione del backup completo non riuscita. Riprova.'));
    } finally {
      setLibraryExportProgress(null);
      setPendingAction(null);
    }
  };

  const handleBackupImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !onImportLibraryBackup) return;

    beginAction('backup-import');
    try {
      const courseCount = await onImportLibraryBackup(file);
      setSuccessMessage(t('{courseCount} corsi importati.', { courseCount }));
    } catch (error) {
      console.error('[Nous][Account] Library backup import failed.', error);
      const correlationId = await reportLibraryArchiveImportFailure(error, file.size);
      const message =
        error instanceof LibraryArchiveError
          ? error.message
          : t('Importazione del backup completo non riuscita. Controlla il file e riprova.');
      setErrorMessage(
        correlationId
          ? `${message} ${t('Codice assistenza: {correlationId}.', { correlationId })}`
          : message
      );
    } finally {
      setPendingAction(null);
    }
  };

  const sectionLabels = {
    preferences: t('Lingua e apprendimento'),
    security: t('Account e sicurezza'),
    data: t('Dati e backup'),
  };
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-3">
      <button
        type="button"
        aria-label={t('Chiudi impostazioni')}
        tabIndex={-1}
        className="absolute inset-0 bg-black/45"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-panel-title"
        className="relative flex h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-stone-200 bg-[#fdfbf7] shadow-2xl sm:h-[43rem] sm:max-h-[calc(100dvh-3rem)] dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200 px-5 py-4 dark:border-zinc-700">
          <div>
            <h2
              ref={titleRef}
              id="account-panel-title"
              tabIndex={-1}
              className="mt-1 text-2xl font-serif text-gray-950 outline-none dark:text-zinc-100"
            >
              {t('Impostazioni')}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t('Chiudi impostazioni')}
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-col sm:flex-row">
          <nav
            aria-label={t('Categorie impostazioni')}
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-stone-200 p-2 sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3 dark:border-zinc-700"
          >
            <button
              type="button"
              aria-current={activeSection === 'preferences' ? 'page' : undefined}
              onClick={() => setActiveSection('preferences')}
              className={categoryClassName}
            >
              <Languages className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{sectionLabels.preferences}</span>
            </button>
            <button
              type="button"
              aria-current={activeSection === 'security' ? 'page' : undefined}
              onClick={() => setActiveSection('security')}
              className={categoryClassName}
            >
              <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{sectionLabels.security}</span>
            </button>
            <button
              type="button"
              aria-current={activeSection === 'data' ? 'page' : undefined}
              onClick={() => setActiveSection('data')}
              className={categoryClassName}
            >
              <Database className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{sectionLabels.data}</span>
            </button>
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-5 text-stone-900 sm:p-6 dark:text-zinc-100">
            <h3 className="mb-5 text-lg font-semibold">{sectionLabels[activeSection]}</h3>
            {successMessage ? (
              <output className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 sm:fixed sm:right-6 sm:top-6 sm:z-[160] sm:mt-0 sm:shadow-lg dark:border-emerald-900/70 dark:bg-emerald-950/50 dark:text-emerald-200">
                {successMessage}
              </output>
            ) : null}
            {errorMessage ? (
              <p
                role="alert"
                className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200"
              >
                {errorMessage}
              </p>
            ) : null}

            <div hidden={activeSection !== 'preferences'}>
              <PreferencesPanel />
            </div>
            {activeSection === 'security' ? (
              <div className="mt-5 space-y-6 sm:space-y-4">
                <div>
                  <p className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
                    {t('Email attuale')}
                  </p>
                  <p className="mt-1 text-sm text-gray-600 dark:text-zinc-300">
                    {account.email || t('Email non disponibile')}
                  </p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-zinc-400">
                    {t('Metodo di accesso: {providers}', {
                      providers: account.providers?.join(', ') || t('non disponibile'),
                    })}
                  </p>
                </div>

                {passwordAccount ? (
                  <>
                    <form
                      className="space-y-3 sm:flex sm:items-end sm:gap-2 sm:space-y-0"
                      onSubmit={handleEmailChange}
                    >
                      <label className="block text-sm font-medium text-gray-700 sm:flex-1 dark:text-zinc-200">
                        {t('Nuovo indirizzo email')}
                        <input
                          type="email"
                          autoComplete="email"
                          required
                          value={newEmail}
                          onChange={event => setNewEmail(event.target.value)}
                          className={fieldClassName}
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={pendingAction !== null}
                        aria-busy={pendingAction === 'email'}
                        className={secondaryActionClassName}
                      >
                        {t('Avvia cambio email')}
                      </button>
                    </form>

                    <form
                      className="space-y-3 border-t border-gray-200 pt-5 sm:flex sm:items-end sm:gap-2 sm:space-y-0 sm:pt-4 dark:border-zinc-700"
                      onSubmit={handlePasswordChange}
                    >
                      <label className="block text-sm font-medium text-gray-700 sm:flex-1 dark:text-zinc-200">
                        {t('Nuova password')}
                        <input
                          type="password"
                          autoComplete="new-password"
                          required
                          value={newPassword}
                          onChange={event => setNewPassword(event.target.value)}
                          className={fieldClassName}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2 sm:shrink-0">
                        <button
                          type="submit"
                          disabled={pendingAction !== null}
                          aria-busy={pendingAction === 'password'}
                          className={secondaryActionClassName}
                        >
                          {t('Cambia password')}
                        </button>
                        <button
                          type="button"
                          disabled={pendingAction !== null || !account.email}
                          aria-busy={pendingAction === 'recovery'}
                          onClick={() => void handleRecovery()}
                          className={secondaryActionClassName}
                        >
                          {t('Invia email di recupero')}
                        </button>
                      </div>
                    </form>
                  </>
                ) : (
                  <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/60">
                    <p className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-zinc-100">
                      <ShieldCheck className="h-4 w-4" />
                      {t('Account gestito da un provider esterno')}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-zinc-300">
                      {t(
                        'Email e password si gestiscono presso il provider usato per accedere. Nous non mostra azioni non applicabili a questo account.'
                      )}
                    </p>
                  </div>
                )}
              </div>
            ) : null}
            {activeSection === 'data' ? (
              <div className="mt-5 space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
                    {t('Backup completo dei corsi')}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-zinc-300">
                    {t(
                      'Esporta tutti i corsi e le fonti in un unico file. Puoi importarlo in un altra installazione di Nous.'
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 border-t border-gray-200 pt-4 dark:border-zinc-700">
                  <button
                    type="button"
                    disabled={pendingAction !== null || !onExportLibraryBackup}
                    aria-busy={pendingAction === 'backup-export'}
                    onClick={() => void handleBackupExport()}
                    className="inline-flex items-center gap-2 rounded-full bg-gray-950 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950"
                  >
                    <Download className="h-4 w-4" />
                    {getLibraryExportLabel(
                      pendingAction === 'backup-export',
                      libraryExportProgress
                    )}
                  </button>
                  {pendingAction === 'backup-export' && libraryExportProgress ? (
                    <output className="w-full text-xs text-gray-500 dark:text-zinc-400">
                      {t('{bytes} byte elaborati dal server.', {
                        bytes: new Intl.NumberFormat().format(libraryExportProgress.bytesWritten),
                      })}
                    </output>
                  ) : null}
                  <input
                    ref={backupInputRef}
                    type="file"
                    className="hidden"
                    accept=".nous-library.zip,.zip,application/zip"
                    aria-label={t('Seleziona backup completo Nous')}
                    onChange={event => void handleBackupImport(event)}
                  />
                  <button
                    type="button"
                    disabled={pendingAction !== null || !onImportLibraryBackup}
                    aria-busy={pendingAction === 'backup-import'}
                    onClick={() => backupInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-full border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-800 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-100"
                  >
                    <Upload className="h-4 w-4" />
                    {pendingAction === 'backup-import'
                      ? t('Importazione in corso...')
                      : t('Importa tutti i corsi')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
