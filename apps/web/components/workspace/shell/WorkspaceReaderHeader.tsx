import { ArrowLeft, Moon, RefreshCw, Settings2, SidebarOpen, Sun, X } from 'lucide-react';
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { MotionPopover } from '../../../utils/motion/index.ts';
import MusicPlayer from '../UnifiedAudioPanel.tsx';
import { HeaderLearningAids } from './LessonLearningAids.tsx';
import type { WorkspaceReaderHeaderModel } from './types.ts';
import WorkspaceReaderSettingsPanel from './WorkspaceReaderSettingsPanel.tsx';

const WorkspaceReaderHeader = memo(function WorkspaceReaderHeader({
  activeSectionTitle,
  activeSidebarGroup,
  hasActiveSection,
  courseGenerationNotes,
  isDarkMode,
  isFocusMode,
  isLoading,
  isMobileSidebarOpen,
  isMobileViewport,
  isMusicPlaying,
  isSettingsOpen,
  lastAudioTab,
  learningPlanTitle,
  learningAids,
  loadingStatus,
  musicUrl,
  musicVolume,
  onBackToLibrary,
  onOpenSidebar,
  onRegenerateActiveSection,
  onSaveLearningAids,
  onSetDarkMode,
  onSetCourseGenerationNotes,
  onSetFocusMode,
  onSetIsMusicPlaying,
  onSetLastAudioTab,
  onSetMusicUrl,
  onSetMusicVolume,
  onSetSettingsOpen,
  onSetSettingsPanelExpandedSections,
  settingsPanelExpandedSections,
  syncState,
  tts,
}: WorkspaceReaderHeaderModel) {
  const [isRegenerateConfirmOpen, setIsRegenerateConfirmOpen] = useState(false);
  const [isAudioOpen, setIsAudioOpen] = useState(false);
  const regenerateConfirmRef = useRef<HTMLDivElement>(null);
  const activeContentTitle = activeSectionTitle || learningPlanTitle || t('Lezione');
  const activeContentGroupTitle = activeSidebarGroup?.title || learningPlanTitle || t('Percorso');
  const canRegenerate = hasActiveSection;
  const isRegenerateConfirmVisible = isRegenerateConfirmOpen && canRegenerate && !isLoading;

  useEffect(() => {
    if (!isRegenerateConfirmVisible) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || regenerateConfirmRef.current?.contains(target)) {
        return;
      }

      setIsRegenerateConfirmOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isRegenerateConfirmVisible]);

  const handleRegenerateIntent = () => {
    if (!canRegenerate || isLoading) {
      return;
    }

    const next = !isRegenerateConfirmOpen;
    setIsRegenerateConfirmOpen(next);
    if (next) {
      onSetSettingsOpen(false);
      setIsAudioOpen(false);
    }
  };

  const handleConfirmRegenerate = () => {
    setIsRegenerateConfirmOpen(false);
    onRegenerateActiveSection();
  };
  const visibleLoadingStatus = isMobileViewport ? loadingStatus : loadingStatus.toUpperCase();
  let loadingBadge: ReactNode = null;
  if (isLoading) {
    loadingBadge = (
      <div
        className={`flex min-w-0 animate-pulse items-center gap-2 rounded-full bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400 ${
          isMobileViewport
            ? 'w-full max-w-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em]'
            : 'max-w-[16rem] px-4 py-1.5 text-xs font-bold'
        }`}
        title={loadingStatus}
      >
        <span className="h-2 w-2 rounded-full bg-orange-500" />
        <span className="truncate">{visibleLoadingStatus}</span>
      </div>
    );
  } else if (syncState === 'error') {
    loadingBadge = <SyncBadge syncState={syncState} />;
  }
  const regenerateDialogClassName = isMobileViewport
    ? 'mx-auto w-[min(20rem,calc(100vw-2rem))]'
    : 'absolute right-0 top-[calc(100%+0.75rem)] z-50 w-[min(20rem,calc(100vw-2rem))]';

  const courseNotesBinding = useMemo(
    () => ({
      value: courseGenerationNotes,
      onChange: onSetCourseGenerationNotes,
    }),
    [courseGenerationNotes, onSetCourseGenerationNotes]
  );

  return (
    <header
      className={`
        sticky top-0 relative z-50 flex flex-shrink-0 overflow-visible border-b border-gray-100 bg-white/80 backdrop-blur transition-opacity duration-500 ease-in-out dark:border-zinc-700/80 dark:bg-zinc-800/80
        ${isMobileViewport ? 'flex-col gap-2.5 px-4 py-2.5 sm:min-h-[4rem]' : 'h-16 items-center justify-between px-8'}
        opacity-100
      `}
    >
      <div
        className={`flex w-full min-w-0 ${
          isMobileViewport ? 'items-start justify-between gap-3' : 'items-center gap-6'
        }`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
          {isMobileViewport ? (
            <>
              <button
                type="button"
                onClick={onBackToLibrary}
                className="rounded-full border border-gray-200 bg-white/85 p-2 text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-600/80 dark:bg-zinc-800/85 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-white"
                title={t('Torna alla libreria')}
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onOpenSidebar}
                className="rounded-full border border-gray-200 bg-white/85 p-2 text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-600/80 dark:bg-zinc-800/85 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-white"
                title={t(isMobileSidebarOpen ? 'Chiudi elenco lezioni' : 'Apri elenco lezioni')}
              >
                {isMobileSidebarOpen ? (
                  <X className="h-4 w-4" />
                ) : (
                  <SidebarOpen className="h-4 w-4" />
                )}
              </button>
              <div className="min-w-0 overflow-hidden">
                <p className="truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
                  {activeContentGroupTitle}
                </p>
                <h2 className="truncate font-serif text-base text-gray-900 dark:text-white">
                  {activeContentTitle}
                </h2>
              </div>
            </>
          ) : isFocusMode ? (
            <button
              type="button"
              onClick={() => onSetFocusMode(false)}
              className="rounded-md p-1 text-gray-400 transition-all hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
              title={t('Mostra Menu')}
            >
              <SidebarOpen className="h-5 w-5" />
            </button>
          ) : null}
        </div>

        <div
          className={`flex min-w-0 shrink-0 items-center justify-end ${
            isMobileViewport ? 'gap-1.5' : 'gap-6'
          }`}
        >
          {!isMobileViewport ? loadingBadge : null}

          <div ref={regenerateConfirmRef} className="relative">
            <button
              type="button"
              onClick={handleRegenerateIntent}
              disabled={!canRegenerate || isLoading}
              className={`inline-flex items-center justify-center rounded-full border transition-colors ${
                isMobileViewport
                  ? 'h-10 w-10'
                  : 'gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em]'
              } ${
                !canRegenerate || isLoading
                  ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-zinc-500'
                  : 'border-gray-200 bg-white/90 text-gray-700 hover:border-orange-300 hover:text-orange-700 dark:border-zinc-600/80 dark:bg-zinc-800/85 dark:text-zinc-200 dark:hover:border-orange-500/60 dark:hover:text-orange-300'
              }`}
              title={t(
                canRegenerate ? 'Rigenera la lezione corrente' : 'Apri una lezione per rigenerarla'
              )}
              aria-expanded={isRegenerateConfirmVisible}
              aria-haspopup="dialog"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              {!isMobileViewport ? <span>{t('Rigenera')}</span> : null}
            </button>

            {isMobileViewport && isRegenerateConfirmVisible ? (
              <div
                className="fixed bottom-0 left-1/2 top-0 z-50 flex w-full -translate-x-1/2 items-start justify-center pt-24"
                role="dialog"
                aria-label={t('Conferma rigenerazione contenuto')}
              >
                <div
                  className={`${regenerateDialogClassName} panel-shadow rounded-2xl border border-gray-200 bg-white px-4 py-4 text-stone-700 dark:border-zinc-600/80 dark:bg-[var(--bg-surface)] dark:text-zinc-200`}
                >
                  <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                    {t('Rigenerare questa lezione?')}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-zinc-400">
                    {t(
                      'Verrà ricreata la lezione corrente a partire dal materiale sorgente e potresti perdere il contenuto attuale.'
                    )}
                  </p>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setIsRegenerateConfirmOpen(false)}
                      className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    >
                      {t('Annulla')}
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirmRegenerate}
                      className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                    >
                      {t('Rigenera')}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {!isMobileViewport ? (
              <MotionPopover
                isOpen={isRegenerateConfirmVisible}
                originX="top right"
                role="dialog"
                aria-label={t('Conferma rigenerazione contenuto')}
                className={`${regenerateDialogClassName} panel-shadow rounded-2xl border border-gray-200 bg-white px-4 py-4 text-stone-700 dark:border-zinc-600/80 dark:bg-[var(--bg-surface)] dark:text-zinc-200`}
              >
                <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  {t('Rigenerare questa lezione?')}
                </p>
                <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-zinc-400">
                  {t(
                    'Verrà ricreata la lezione corrente a partire dal materiale sorgente e potresti perdere il contenuto attuale.'
                  )}
                </p>
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsRegenerateConfirmOpen(false)}
                    className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    {t('Annulla')}
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmRegenerate}
                    className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                  >
                    {t('Rigenera')}
                  </button>
                </div>
              </MotionPopover>
            ) : null}
          </div>

          <MusicPlayer
            isMobileViewport={isMobileViewport}
            isOpen={isAudioOpen}
            onToggle={open => {
              setIsAudioOpen(open);
              if (open) onSetSettingsOpen(false);
            }}
            initialTab={lastAudioTab}
            onTabChange={onSetLastAudioTab}
            musicUrl={musicUrl}
            setMusicUrl={onSetMusicUrl}
            isMusicPlaying={isMusicPlaying}
            setIsMusicPlaying={onSetIsMusicPlaying}
            musicVolume={musicVolume}
            setMusicVolume={onSetMusicVolume}
            tts={tts}
          />

          {!isMobileViewport && hasActiveSection ? (
            <HeaderLearningAids
              isDarkMode={isDarkMode}
              learningAids={learningAids}
              onSaveLearningAids={onSaveLearningAids}
            />
          ) : null}

          {!isMobileViewport ? (
            <div className="mx-1 h-4 w-px bg-gray-300 dark:bg-zinc-600" />
          ) : null}

          <button
            type="button"
            onClick={() => {
              onSetSettingsOpen(!isSettingsOpen);
              if (!isSettingsOpen) setIsAudioOpen(false);
            }}
            onPointerDown={e => e.stopPropagation()}
            className="rounded-full border border-transparent bg-transparent p-2 text-gray-400 transition-colors hover:border-gray-200 hover:bg-gray-100 hover:text-gray-600 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
            title={t('Apri impostazioni lettura')}
          >
            <Settings2 className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={() => onSetDarkMode(!isDarkMode)}
            className="rounded-full border border-transparent bg-transparent p-2 text-gray-400 transition-colors hover:border-gray-200 hover:bg-gray-100 hover:text-gray-600 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
            title={t('Cambia Tema')}
          >
            {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {isMobileViewport && loadingBadge ? (
        <div className="w-full min-w-0">{loadingBadge}</div>
      ) : null}

      {isSettingsOpen ? (
        <WorkspaceReaderSettingsPanel
          courseNotes={courseNotesBinding}
          expandedSections={settingsPanelExpandedSections}
          onClose={() => onSetSettingsOpen(false)}
          onSectionToggle={onSetSettingsPanelExpandedSections}
        />
      ) : null}
    </header>
  );
});

export default WorkspaceReaderHeader;

/** Small non-intrusive badge showing persistence sync state. */
function SyncBadge({ syncState }: { syncState: 'saved' | 'saving' | 'error' }) {
  if (syncState !== 'error') return null;

  return (
    <div
      className="flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-red-600 dark:bg-red-900/20 dark:text-red-400"
      title={t('Errore di salvataggio')}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      <span>{t('Errore')}</span>
    </div>
  );
}
