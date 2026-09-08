import { LogOut, MessageSquareWarning, Moon, Settings, Sun, UserRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  isSupabaseAuthEnabled,
  loadSupabaseAccount,
  readSupabaseSession,
  type SupabaseAccount,
  signOutSupabase,
  subscribeToSupabaseSession,
} from '../../services/auth/supabaseAuth.ts';
import type { LibraryExportProgressListener } from '../../services/projects/projectRepository.ts';
import FeedbackDialog from '../feedback/FeedbackDialog.tsx';
import AccountSettingsDialog, { type AccountSection } from './AccountSettingsDialog.tsx';
import AccountUsage from './AccountUsage.tsx';

interface AccountMenuProps {
  readonly onExportLibraryBackup?: (onProgress?: LibraryExportProgressListener) => Promise<number>;
  readonly onImportLibraryBackup?: (file: File) => Promise<number>;
  readonly themeToggle?: {
    readonly isDarkMode: boolean;
    readonly onToggle: () => void;
  };
  readonly triggerText?: string;
  readonly triggerVariant?: 'avatar' | 'settings';
}

export default function AccountMenu({
  onExportLibraryBackup,
  onImportLibraryBackup,
  themeToggle,
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
  const menuRef = useRef<HTMLDivElement>(null);
  const accountIdRef = useRef(account?.id);

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
        if (accountIdRef.current !== session?.user?.id) {
          setIsMenuOpen(false);
          setPanelSection(null);
          setIsFeedbackOpen(false);
          accountIdRef.current = session?.user?.id;
        }
        setAccount(session?.user || null);
      }
    });

    if (readSupabaseSession()) {
      void loadSupabaseAccount()
        .then(nextAccount => {
          if (isActive && readSupabaseSession()?.user?.id === nextAccount.id) {
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
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        closeMenu();
        return;
      }
      const controls = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ??
          []
      );
      if (controls.length === 0) return;
      const index = controls.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === 'ArrowDown') next = (index + 1) % controls.length;
      else if (event.key === 'ArrowUp') next = (index - 1 + controls.length) % controls.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = controls.length - 1;
      else return;
      event.preventDefault();
      controls[next]?.focus();
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

  const accountLabel = account?.name || account?.email || t('Account utente');

  return (
    <div
      className={
        triggerVariant === 'settings' ? 'relative space-y-1' : 'relative flex items-center gap-1'
      }
    >
      <button
        ref={feedbackTriggerRef}
        type="button"
        aria-label={
          triggerVariant === 'settings' ? t('Segnala problema') : t('Segnala un problema')
        }
        disabled={!account}
        onClick={() => {
          setIsMenuOpen(false);
          setIsFeedbackOpen(true);
        }}
        className={
          triggerVariant === 'settings'
            ? 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-50 dark:text-stone-400 dark:hover:bg-white/5'
            : 'inline-flex h-10 w-10 items-center justify-center rounded-full text-stone-600 dark:text-zinc-300'
        }
      >
        <MessageSquareWarning className="h-4 w-4 shrink-0" />
        {triggerVariant === 'settings' ? (
          <span className="whitespace-nowrap">{t('Segnala problema')}</span>
        ) : null}
      </button>
      {themeToggle ? (
        <button
          type="button"
          onClick={themeToggle.onToggle}
          aria-label={themeToggle.isDarkMode ? t('Usa tema chiaro') : t('Usa tema scuro')}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-stone-600 dark:text-zinc-300"
        >
          {themeToggle.isDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
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
            : 'inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-gray-300 bg-paper-light text-gray-600 transition-colors hover:border-gray-400 hover:text-gray-950 dark:border-zinc-500/60 dark:bg-paper-surface dark:text-zinc-300 dark:hover:border-zinc-400 dark:hover:text-white'
        }
      >
        {triggerVariant === 'settings' ? (
          <>
            <UserRound className="h-4 w-4 shrink-0" />
            <span className="truncate">{accountLabel}</span>
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
            tabIndex={-1}
            className="fixed inset-0 z-[70]"
            onClick={closeMenu}
          />
          <div
            ref={menuRef}
            className={`absolute z-[80] w-64 overflow-hidden rounded-2xl border border-gray-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 ${
              triggerVariant === 'settings' ? 'bottom-12 left-0' : 'right-0 top-12'
            }`}
          >
            <div className="border-b border-gray-100 px-3 py-2.5 dark:border-zinc-800">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-zinc-100">
                {accountLabel}
              </p>
              {account?.name && account.email ? (
                <p className="truncate text-xs text-gray-500 dark:text-zinc-400">{account.email}</p>
              ) : null}
            </div>
            {account ? <AccountUsage key={account.id} /> : null}
            {menuError ? (
              <p role="alert" className="m-2 text-xs leading-5 text-red-600 dark:text-red-300">
                {menuError}
              </p>
            ) : null}
            <div role="menu" aria-label={t('Menu account')}>
              <button
                type="button"
                role="menuitem"
                disabled={!account}
                onClick={() => openPanel('preferences')}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                <Settings className="h-4 w-4" />
                {t('Impostazioni')}
              </button>
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
          </div>
        </>
      ) : null}

      {panelSection && account ? (
        <AccountSettingsDialog
          key={account.id}
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
