import {
  Archive,
  Download,
  KeyRound,
  LogOut,
  MessageSquareWarning,
  Settings,
  ShieldCheck,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  isPasswordAccount,
  isSupabaseAuthEnabled,
  loadSupabaseAccount,
  readSupabaseSession,
  requestSupabaseEmailChange,
  type SupabaseAccount,
  sendPasswordRecovery,
  signOutSupabase,
  subscribeToSupabaseSession,
  updateSupabasePassword,
} from '../../services/auth/supabaseAuth.ts';
import { LibraryArchiveError } from '../../services/projects/libraryArchive.ts';
import { reportLibraryArchiveImportFailure } from '../../services/projects/libraryArchiveDiagnostics.ts';
import FeedbackDialog from '../feedback/FeedbackDialog.tsx';

type AccountSection = 'data' | 'security';
type AccountAction =
  | 'backup-export'
  | 'backup-import'
  | 'email'
  | 'logout'
  | 'password'
  | 'recovery';

const SUCCESS_MESSAGE_DURATION_MS = 3_000;

interface AccountPanelProps {
  readonly account: SupabaseAccount;
  readonly initialSection: AccountSection;
  readonly onAccountChange: (account: SupabaseAccount) => void;
  readonly onClose: () => void;
  readonly onExportLibraryBackup?: () => Promise<number>;
  readonly onImportLibraryBackup?: (file: File) => Promise<number>;
}

const fieldClassName =
  'mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-950 outline-none focus:border-gray-900 disabled:bg-gray-100 disabled:text-gray-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-400';

const AccountPanel = ({
  account,
  initialSection,
  onAccountChange,
  onClose,
  onExportLibraryBackup,
  onImportLibraryBackup,
}: AccountPanelProps) => {
  const [activeSection, setActiveSection] = useState<AccountSection>(initialSection);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pendingAction, setPendingAction] = useState<AccountAction | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const passwordAccount = isPasswordAccount(account);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
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

  const handleEmailChange = async (event: FormEvent) => {
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

  const handlePasswordChange = async (event: FormEvent) => {
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
      const courseCount = await onExportLibraryBackup();
      setSuccessMessage(t('Backup di {courseCount} corsi esportato.', { courseCount }));
    } catch (error) {
      console.error('[Nous][Account] Library backup export failed.', error);
      setErrorMessage(t('Esportazione del backup completo non riuscita. Riprova.'));
    } finally {
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

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end p-3 sm:items-center sm:justify-center">
      <button
        type="button"
        aria-label={t('Chiudi area account')}
        className="absolute inset-0 bg-black/45 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-panel-title"
        className="relative max-h-[calc(100vh-1.5rem)] w-full max-w-2xl overflow-y-auto rounded-[1.8rem] border border-gray-200 bg-white p-5 shadow-2xl sm:p-6 dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400 dark:text-zinc-500">
              {t('Area account')}
            </p>
            <h2
              ref={titleRef}
              id="account-panel-title"
              tabIndex={-1}
              className="mt-1 text-2xl font-serif text-gray-950 outline-none dark:text-zinc-100"
            >
              {activeSection === 'security' ? t('Account e sicurezza') : t('Dati e backup')}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t('Chiudi area account')}
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-b border-gray-200 pb-4 dark:border-zinc-700">
          <button
            type="button"
            aria-pressed={activeSection === 'security'}
            onClick={() => setActiveSection('security')}
            className="rounded-full px-4 py-2 text-sm font-semibold text-gray-600 transition-colors aria-pressed:bg-gray-950 aria-pressed:text-white dark:text-zinc-300 dark:aria-pressed:bg-zinc-100 dark:aria-pressed:text-zinc-950"
          >
            {t('Account e sicurezza')}
          </button>
          <button
            type="button"
            aria-pressed={activeSection === 'data'}
            onClick={() => setActiveSection('data')}
            className="rounded-full px-4 py-2 text-sm font-semibold text-gray-600 transition-colors aria-pressed:bg-gray-950 aria-pressed:text-white dark:text-zinc-300 dark:aria-pressed:bg-zinc-100 dark:aria-pressed:text-zinc-950"
          >
            {t('Dati e backup')}
          </button>
        </div>

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
                    className="rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-800 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-100"
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
                      className="rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-800 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-100"
                    >
                      {t('Cambia password')}
                    </button>
                    <button
                      type="button"
                      disabled={pendingAction !== null || !account.email}
                      aria-busy={pendingAction === 'recovery'}
                      onClick={() => void handleRecovery()}
                      className="rounded-full px-4 py-2 text-sm font-semibold text-gray-600 disabled:cursor-wait disabled:opacity-60 dark:text-zinc-300"
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
        ) : activeSection === 'data' ? (
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
                {pendingAction === 'backup-export'
                  ? t('Esportazione in corso...')
                  : t('Esporta tutti i corsi')}
              </button>
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
    </div>,
    document.body
  );
};

interface AccountMenuProps {
  readonly onExportLibraryBackup?: () => Promise<number>;
  readonly onImportLibraryBackup?: (file: File) => Promise<number>;
  readonly triggerText?: string;
  readonly triggerVariant?: 'avatar' | 'settings';
}

export default function AccountMenu({
  onExportLibraryBackup,
  onImportLibraryBackup,
  triggerText,
  triggerVariant = 'avatar',
}: AccountMenuProps = {}) {
  const [account, setAccount] = useState<SupabaseAccount | null>(
    () => readSupabaseSession()?.user || null
  );
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [panelSection, setPanelSection] = useState<AccountSection | null>(null);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [menuError, setMenuError] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const feedbackTriggerRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback(() => {
    setIsMenuOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  const closePanel = useCallback(() => {
    setPanelSection(null);
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  const closeFeedback = useCallback(() => {
    setIsFeedbackOpen(false);
    queueMicrotask(() => (feedbackTriggerRef.current || triggerRef.current)?.focus());
  }, []);

  useEffect(() => {
    if (!isSupabaseAuthEnabled()) {
      return;
    }

    let isActive = true;
    const unsubscribe = subscribeToSupabaseSession(session => {
      if (isActive) {
        setAccount(session?.user || null);
      }
    });

    if (readSupabaseSession()) {
      void loadSupabaseAccount()
        .then(nextAccount => {
          if (isActive) {
            setAccount(nextAccount);
          }
        })
        .catch(error => {
          console.error('[Nous][Account] Account load failed.', error);
          if (isActive) {
            setMenuError(t('Dati account temporaneamente non disponibili. Riprova.'));
          }
        });
    }

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeMenu, isMenuOpen]);

  if (!isSupabaseAuthEnabled()) {
    return null;
  }

  const openPanel = (section: AccountSection) => {
    setMenuError('');
    setIsMenuOpen(false);
    setPanelSection(section);
  };

  const handleLogout = async () => {
    if (isLoggingOut) {
      return;
    }
    setIsLoggingOut(true);
    setMenuError('');
    try {
      await signOutSupabase();
    } catch (error) {
      console.error('[Nous][Account] Sign out failed.', error);
      setMenuError(t('Logout non riuscito. Riprova.'));
      setIsLoggingOut(false);
    }
  };

  const accountLabel = account?.email || t('Account utente');

  return (
    <div className={triggerVariant === 'settings' ? 'relative space-y-1' : 'relative'}>
      {triggerVariant === 'settings' ? (
        <button
          ref={feedbackTriggerRef}
          type="button"
          disabled={!account}
          onClick={() => {
            setIsMenuOpen(false);
            setIsFeedbackOpen(true);
          }}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50 dark:text-stone-400 dark:hover:bg-white/5"
        >
          <MessageSquareWarning className="h-4 w-4 shrink-0" />
          <span className="whitespace-nowrap">{t('Segnala problema')}</span>
        </button>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={isMenuOpen}
        aria-haspopup="menu"
        aria-label={t('Apri menu account per {accountLabel}', { accountLabel })}
        onClick={() => {
          setMenuError('');
          setIsMenuOpen(current => !current);
        }}
        className={
          triggerVariant === 'settings'
            ? 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-stone-600 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-white/5'
            : 'inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-gray-300 bg-white text-gray-600 transition-colors hover:border-gray-400 hover:text-gray-950 dark:border-zinc-500/60 dark:bg-paper-surface dark:text-zinc-300 dark:hover:border-zinc-400 dark:hover:text-white'
        }
      >
        {triggerVariant === 'settings' ? (
          <>
            <Settings className="h-4 w-4" />
            {t('Impostazioni')}
          </>
        ) : triggerText ? (
          <span className="text-sm font-semibold" aria-hidden="true">
            {triggerText}
          </span>
        ) : (
          <UserRound className="h-5 w-5" />
        )}
      </button>

      {isMenuOpen ? (
        <>
          <button
            type="button"
            aria-label={t('Chiudi menu account')}
            className="fixed inset-0 z-[70]"
            onClick={closeMenu}
          />
          <div
            role="menu"
            aria-label={t('Menu account')}
            className={`absolute z-[80] w-64 overflow-hidden rounded-2xl border border-gray-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 ${
              triggerVariant === 'settings' ? 'bottom-12 left-0' : 'right-0 top-12'
            }`}
          >
            <div className="border-b border-gray-100 px-3 py-2.5 dark:border-zinc-800">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-zinc-100">
                {accountLabel}
              </p>
            </div>
            {menuError ? (
              <p role="alert" className="m-2 text-xs leading-5 text-red-600 dark:text-red-300">
                {menuError}
              </p>
            ) : null}
            <button
              type="button"
              role="menuitem"
              disabled={!account}
              onClick={() => openPanel('security')}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              <KeyRound className="h-4 w-4" />
              {t('Account e sicurezza')}
            </button>
            {onExportLibraryBackup && onImportLibraryBackup ? (
              <button
                type="button"
                role="menuitem"
                disabled={!account}
                onClick={() => openPanel('data')}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                <Archive className="h-4 w-4" />
                {t('Dati e backup')}
              </button>
            ) : null}
            {triggerVariant !== 'settings' ? (
              <button
                type="button"
                role="menuitem"
                disabled={!account}
                onClick={() => {
                  setIsMenuOpen(false);
                  setIsFeedbackOpen(true);
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                <MessageSquareWarning className="h-4 w-4" />
                {t('Segnala un problema')}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              disabled={isLoggingOut}
              aria-busy={isLoggingOut}
              onClick={() => void handleLogout()}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm text-red-600 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <LogOut className="h-4 w-4" />
              {isLoggingOut ? t('Logout in corso...') : t('Logout')}
            </button>
          </div>
        </>
      ) : null}

      {panelSection && account ? (
        <AccountPanel
          account={account}
          initialSection={panelSection}
          onAccountChange={setAccount}
          onClose={closePanel}
          onExportLibraryBackup={onExportLibraryBackup}
          onImportLibraryBackup={onImportLibraryBackup}
        />
      ) : null}

      {isFeedbackOpen && account ? <FeedbackDialog onClose={closeFeedback} /> : null}
    </div>
  );
}
