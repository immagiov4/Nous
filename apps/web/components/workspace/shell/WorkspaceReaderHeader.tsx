import { Moon, Play, Settings2, SidebarOpen, Sun } from 'lucide-react';
import { memo, type ReactNode, useMemo, useState } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import MusicPlayer from '../UnifiedAudioPanel.tsx';
import { HeaderLearningAids, MobileLearningAids } from './LessonLearningAids.tsx';
import type { WorkspaceReaderHeaderModel } from './types.ts';
import WorkspaceReaderSettingsPanel from './WorkspaceReaderSettingsPanel.tsx';

const WorkspaceReaderHeader = memo(function WorkspaceReaderHeader({
  hasActiveSection,
  courseGenerationNotes,
  isDarkMode,
  isFocusMode,
  isLoading,
  isMobileViewport,
  isMusicPlaying,
  isMobileSidebarOpen,
  isSettingsOpen,
  lastAudioTab,
  learningAids,
  loadingStatus,
  musicUrl,
  musicVolume,
  onOpenSidebar,
  onRegenerateActiveSection,
  onPlayLesson,
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
  useAppLocale();
  const [isAudioOpen, setIsAudioOpen] = useState(false);
  const [isMobileLearningAidsOpen, setIsMobileLearningAidsOpen] = useState(false);
  const canRegenerate = hasActiveSection;
  const visibleLoadingStatus = isMobileViewport ? loadingStatus : loadingStatus.toUpperCase();
  let regenerateAvailabilityClassName = '';
  if (!canRegenerate || isLoading) {
    regenerateAvailabilityClassName =
      'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-zinc-500';
  } else if (!isMobileViewport) {
    regenerateAvailabilityClassName =
      'border-gray-200 bg-white/90 text-gray-700 hover:border-orange-300 hover:text-orange-700 dark:border-zinc-600/80 dark:bg-zinc-800/85 dark:text-zinc-200 dark:hover:border-orange-500/60 dark:hover:text-orange-300';
  }
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
        z-50 flex flex-shrink-0 overflow-visible transition-opacity duration-500 ease-in-out
        ${
          isMobileViewport
            ? 'pointer-events-none absolute inset-x-0 top-0 flex-col items-stretch gap-2 bg-transparent px-4 pb-3 pt-4'
            : 'sticky top-0 h-16 items-center justify-between border-b border-gray-100 bg-white/80 px-8 backdrop-blur dark:border-zinc-700/80 dark:bg-zinc-800/80'
        }
        opacity-100
      `}
    >
      <div
        className={`flex w-full min-w-0 ${
          isMobileViewport ? 'items-start justify-between gap-3' : 'items-center gap-6'
        }`}
      >
        <div
          className={`flex min-w-0 items-center gap-3 overflow-hidden ${isMobileViewport ? '' : 'flex-1'}`}
        >
          {isMobileViewport ? (
            <div className="pointer-events-auto flex items-center">
              <button
                type="button"
                aria-expanded={isMobileSidebarOpen}
                aria-label={t('Apri elenco lezioni')}
                onClick={onOpenSidebar}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-gray-300/80 bg-white text-gray-500 shadow-sm transition-colors hover:border-gray-400 hover:text-gray-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
                title={t('Apri elenco lezioni')}
              >
                <SidebarOpen className="reader-mobile-control-icon" />
              </button>
            </div>
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
          className={`pointer-events-auto flex min-w-0 shrink-0 items-center justify-end ${
            isMobileViewport
              ? 'gap-0.5 rounded-full border border-gray-300/80 bg-white px-1.5 py-0.5 shadow-sm dark:border-zinc-600 dark:bg-zinc-800 dark:shadow-none'
              : 'gap-6'
          }`}
        >
          {!isMobileViewport ? loadingBadge : null}

          <div className="relative">
            <button
              type="button"
              onClick={onPlayLesson}
              disabled={!canRegenerate || isLoading}
              className={`inline-flex items-center justify-center rounded-full border transition-colors ${
                isMobileViewport
                  ? 'h-9 w-9 border-0 bg-transparent text-gray-400 hover:bg-black/5 hover:text-gray-600 dark:bg-transparent dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200'
                  : 'h-10 gap-2 px-4 text-xs font-semibold uppercase tracking-[0.14em]'
              } ${regenerateAvailabilityClassName}`}
              title={t(
                canRegenerate ? 'Riproduci la lezione corrente' : 'Apri una lezione per ascoltarla'
              )}
            >
              <Play
                className={`${isMobileViewport ? 'reader-mobile-control-icon' : 'h-4 w-4'} ${isLoading ? 'animate-spin' : ''}`}
              />
              {!isMobileViewport ? <span>{t('Riproduci')}</span> : null}
            </button>
          </div>

          {isMobileViewport && hasActiveSection ? (
            <MobileLearningAids
              isDarkMode={isDarkMode}
              learningAids={learningAids}
              onSaveLearningAids={onSaveLearningAids}
              isOpen={isMobileLearningAidsOpen}
              onOpenChange={open => {
                setIsMobileLearningAidsOpen(open);
                if (open) {
                  setIsAudioOpen(false);
                  onSetSettingsOpen(false);
                }
              }}
            />
          ) : null}

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

          <MusicPlayer
            isMobileViewport={isMobileViewport}
            isOpen={isAudioOpen}
            onToggle={open => {
              setIsAudioOpen(open);
              if (open) {
                onSetSettingsOpen(false);
                setIsMobileLearningAidsOpen(false);
              }
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

          <button
            type="button"
            onClick={() => {
              onSetSettingsOpen(!isSettingsOpen);
              if (!isSettingsOpen) {
                setIsAudioOpen(false);
                setIsMobileLearningAidsOpen(false);
              }
            }}
            onPointerDown={e => e.stopPropagation()}
            className={
              isMobileViewport
                ? 'inline-flex h-9 w-9 items-center justify-center rounded-full border-0 bg-transparent p-2 text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-600 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200'
                : 'rounded-full border border-transparent bg-transparent p-2 text-gray-400 transition-colors hover:border-gray-200 hover:bg-gray-100 hover:text-gray-600 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300'
            }
            title={t('Apri impostazioni lettura')}
          >
            <Settings2 className={isMobileViewport ? 'reader-mobile-control-icon' : 'h-5 w-5'} />
          </button>

          <button
            type="button"
            onClick={() => onSetDarkMode(!isDarkMode)}
            className={
              isMobileViewport
                ? 'inline-flex h-9 w-9 items-center justify-center rounded-full border-0 bg-transparent p-2 text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-600 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200'
                : 'rounded-full border border-transparent bg-transparent p-2 text-gray-400 transition-colors hover:border-gray-200 hover:bg-gray-100 hover:text-gray-600 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300'
            }
            title={t('Cambia Tema')}
          >
            {isDarkMode ? (
              <Sun className={isMobileViewport ? 'reader-mobile-control-icon' : 'h-5 w-5'} />
            ) : (
              <Moon className={isMobileViewport ? 'reader-mobile-control-icon' : 'h-5 w-5'} />
            )}
          </button>
        </div>
      </div>

      {isMobileViewport && loadingBadge ? (
        <div className="w-full min-w-0">{loadingBadge}</div>
      ) : null}

      {isSettingsOpen ? (
        <WorkspaceReaderSettingsPanel
          canRegenerate={canRegenerate && !isLoading}
          onRegenerate={onRegenerateActiveSection}
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

import { useAppLocale } from '../../../hooks/useAppLocale.ts';
