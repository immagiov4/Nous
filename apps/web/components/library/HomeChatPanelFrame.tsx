import { motion } from 'framer-motion';
import { BookPlus, Folder, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { HomeChatMode } from '../../types.ts';
import type { StopGenerationHandler } from './HomeChatComposer.tsx';

const MOBILE_ACTIVE_CHAT_VIEWPORT_RATIO = 0.75;

const getMobileChatStyle = (
  isMobileViewport: boolean,
  viewportHeight: number | null,
  hasActiveChat: boolean
) => {
  if (!isMobileViewport || viewportHeight == null) return undefined;
  if (hasActiveChat) {
    return { height: `${Math.floor(viewportHeight * MOBILE_ACTIVE_CHAT_VIEWPORT_RATIO)}px` };
  }
  return { maxHeight: `${viewportHeight}px` };
};

const HomeChatModeSelector = ({
  disabled,
  homeChatMode,
  onChange,
}: {
  readonly disabled: boolean;
  readonly homeChatMode: HomeChatMode;
  readonly onChange: (mode: HomeChatMode) => void;
}) => (
  <div
    className="relative inline-flex rounded-full border border-gray-300/80 bg-white p-1 shadow-[0_1px_2px_rgba(24,24,27,0.04)] dark:border-white/10 dark:bg-stone-900/80"
    role="tablist"
    aria-label={t('Modalità home chat')}
  >
    {(
      [
        { icon: BookPlus, label: t('Nuovo corso'), mode: 'new-course' },
        { icon: Folder, label: t('Consulta libreria'), mode: 'library-query' },
      ] as const
    ).map(option => {
      const Icon = option.icon;
      const isActive = homeChatMode === option.mode;
      return (
        <button
          key={option.mode}
          type="button"
          role="tab"
          aria-selected={isActive}
          disabled={disabled}
          onClick={() => onChange(option.mode)}
          className={`relative inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:gap-2 sm:px-5 sm:py-2.5 sm:text-sm ${
            isActive
              ? 'text-white dark:text-stone-900'
              : 'text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-100'
          }`}
        >
          {isActive ? (
            <motion.span
              layoutId="home-chat-mode-pill"
              className="absolute inset-0 rounded-full bg-stone-900 dark:bg-stone-100"
              transition={{ duration: 0.15, ease: [0.2, 0.85, 0.25, 1] }}
              aria-hidden="true"
            />
          ) : null}
          <span className="relative z-10 inline-flex items-center gap-1.5 sm:gap-2">
            <Icon className="h-4 w-4" />
            {option.label}
          </span>
        </button>
      );
    })}
  </div>
);

const HomeChatHeader = ({
  disableModeChange,
  hideHeaderCopy,
  hideModeSelector,
  homeChatMode,
  onModeChange,
}: {
  readonly disableModeChange: boolean;
  readonly hideHeaderCopy: boolean;
  readonly hideModeSelector: boolean;
  readonly homeChatMode: HomeChatMode;
  readonly onModeChange: (mode: HomeChatMode) => void;
}) => {
  if (hideHeaderCopy && hideModeSelector) return null;
  const title =
    homeChatMode === 'new-course' ? t('Imposta un nuovo corso') : t('Consulta la tua libreria');
  const description =
    homeChatMode === 'new-course'
      ? t('Bastano poche righe: obiettivo, livello di partenza, scadenza e materiale disponibile.')
      : t('Interroga corsi, lezioni, note e highlight della libreria.');
  return (
    <div className="rounded-t-[2rem] border-b border-gray-200/55 py-4 pl-5 pr-16 dark:border-zinc-700/40 sm:pl-6 sm:pr-20">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        {hideHeaderCopy ? (
          <div />
        ) : (
          <div data-testid="home-chat-mode-copy" className="min-h-[6rem] sm:min-h-[4.5rem]">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-serif text-2xl text-gray-900 dark:text-zinc-100">{title}</h2>
            </div>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-gray-600 dark:text-zinc-400">
              {description}
            </p>
          </div>
        )}
        <div className="flex self-start items-center gap-2">
          {hideModeSelector ? null : (
            <HomeChatModeSelector
              disabled={disableModeChange}
              homeChatMode={homeChatMode}
              onChange={onModeChange}
            />
          )}
        </div>
      </div>
    </div>
  );
};

const HomeChatClearButton = ({
  homeChatMode,
  isLoading,
  onCancelNewCourse,
  onClearLibraryMessages,
}: {
  readonly homeChatMode: HomeChatMode;
  readonly isLoading: boolean;
  readonly onCancelNewCourse?: StopGenerationHandler;
  readonly onClearLibraryMessages?: () => void;
}) => {
  const label =
    homeChatMode === 'new-course' ? t('Annulla creazione corso') : t('Pulisci questa chat');
  return (
    <button
      type="button"
      onClick={homeChatMode === 'new-course' ? onCancelNewCourse : onClearLibraryMessages}
      disabled={isLoading}
      className="absolute right-3 top-3 z-10 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-300/80 bg-white text-gray-500 shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-gray-400 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500 disabled:cursor-not-allowed disabled:opacity-50 sm:right-4 sm:top-4 dark:border-white/10 dark:bg-stone-900/80 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-100 dark:focus-visible:ring-stone-300"
      title={label}
      aria-label={label}
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
};

interface HomeChatPanelFrameProps {
  readonly children: ReactNode;
  readonly hasActiveChat: boolean;
  readonly hideHeaderCopy: boolean;
  readonly hideModeSelector: boolean;
  readonly homeChatMode: HomeChatMode;
  readonly isAnyChatLoading: boolean;
  readonly isCompactSurface: boolean;
  readonly isLoading: boolean;
  readonly isMobileViewport: boolean;
  readonly onCancelNewCourse?: StopGenerationHandler;
  readonly onClearLibraryMessages?: () => void;
  readonly onModeChange: (mode: HomeChatMode) => void;
  readonly showClearChat: boolean;
  readonly viewportHeight: number | null;
}

export default function HomeChatPanelFrame({
  children,
  hasActiveChat,
  hideHeaderCopy,
  hideModeSelector,
  homeChatMode,
  isAnyChatLoading,
  isCompactSurface,
  isLoading,
  isMobileViewport,
  onCancelNewCourse,
  onClearLibraryMessages,
  onModeChange,
  showClearChat,
  viewportHeight,
}: HomeChatPanelFrameProps) {
  return (
    <section
      className={`relative max-md:flex max-md:flex-col ${
        isCompactSurface
          ? 'rounded-none bg-transparent shadow-none dark:bg-transparent dark:shadow-none'
          : 'rounded-[2rem] bg-[rgba(248,245,240,0.96)] shadow-[inset_0_1px_3px_rgba(24,24,27,0.05),inset_0_0_0_1px_rgba(88,64,32,0.04)] dark:bg-[rgba(46,40,36,0.94)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
      } ${hasActiveChat ? 'max-md:h-[75dvh] max-md:overflow-hidden' : ''}`}
      style={getMobileChatStyle(isMobileViewport, viewportHeight, hasActiveChat)}
    >
      {showClearChat ? (
        <HomeChatClearButton
          homeChatMode={homeChatMode}
          isLoading={isLoading}
          onCancelNewCourse={onCancelNewCourse}
          onClearLibraryMessages={onClearLibraryMessages}
        />
      ) : null}

      <HomeChatHeader
        disableModeChange={isAnyChatLoading}
        hideHeaderCopy={hideHeaderCopy}
        hideModeSelector={hideModeSelector}
        homeChatMode={homeChatMode}
        onModeChange={onModeChange}
      />

      {children}
    </section>
  );
}
