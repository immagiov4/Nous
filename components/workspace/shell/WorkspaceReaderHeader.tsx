import { ArrowLeft, Moon, RefreshCw, Settings2, SidebarOpen, Sun, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import MusicPlayer from '../MusicPlayer.tsx';
import type { WorkspaceReaderHeaderModel } from './types.ts';
import WorkspaceReaderSettingsPanel from './WorkspaceReaderSettingsPanel.tsx';

export default function WorkspaceReaderHeader({
  activeSection,
  activeSidebarGroup,
  isDarkMode,
  isFocusMode,
  isLoading,
  isMobileSidebarOpen,
  isMobileViewport,
  isMusicPlaying,
  isSettingsOpen,
  learningPlanTitle,
  loadingStatus,
  modelDefaults,
  musicUrl,
  musicVolume,
  onBackToLibrary,
  onOpenSidebar,
  onRegenerateActiveSection,
  onSetDarkMode,
  onSetFocusMode,
  onSetIsMusicPlaying,
  onSetMusicUrl,
  onSetMusicVolume,
  onSetPreferredOpenRouterModel,
  onSetSettingsOpen,
  preferredModels,
}: WorkspaceReaderHeaderModel) {
  const [isRegenerateConfirmOpen, setIsRegenerateConfirmOpen] = useState(false);
  const regenerateConfirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isRegenerateConfirmOpen) {
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
  }, [isRegenerateConfirmOpen]);

  useEffect(() => {
    if (!activeSection || isLoading) {
      setIsRegenerateConfirmOpen(false);
    }
  }, [activeSection, isLoading]);

  const handleRegenerateIntent = () => {
    if (!activeSection || isLoading) {
      return;
    }

    setIsRegenerateConfirmOpen(currentValue => !currentValue);
  };

  const handleConfirmRegenerate = () => {
    setIsRegenerateConfirmOpen(false);
    onRegenerateActiveSection();
  };
  const visibleLoadingStatus = isMobileViewport ? loadingStatus : loadingStatus.toUpperCase();
  const loadingBadge = isLoading ? (
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
  ) : null;
  const regenerateDialogClassName = isMobileViewport
    ? 'fixed left-1/2 top-[calc(env(safe-area-inset-top,0px)+5.5rem)] z-50 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2'
    : 'absolute right-0 top-[calc(100%+0.75rem)] z-50 w-[min(20rem,calc(100vw-2rem))]';

  return (
    <header
      className={`
        sticky top-0 relative z-50 flex flex-shrink-0 overflow-visible border-b border-gray-100 bg-white/80 backdrop-blur transition-opacity duration-500 ease-in-out dark:border-zinc-700/80 dark:bg-zinc-800/80
        ${isMobileViewport ? 'min-h-[4.5rem] flex-col gap-3 px-4 py-3' : 'h-16 items-center justify-between px-8'}
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
                title="Torna alla libreria"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onOpenSidebar}
                className="rounded-full border border-gray-200 bg-white/85 p-2 text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-600/80 dark:bg-zinc-800/85 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-white"
                title={isMobileSidebarOpen ? 'Chiudi elenco lezioni' : 'Apri elenco lezioni'}
              >
                {isMobileSidebarOpen ? (
                  <X className="h-4 w-4" />
                ) : (
                  <SidebarOpen className="h-4 w-4" />
                )}
              </button>
              <div className="min-w-0 overflow-hidden">
                <p className="truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
                  {activeSidebarGroup?.title || learningPlanTitle || 'Percorso'}
                </p>
                <h2 className="truncate font-serif text-base text-gray-900 dark:text-white">
                  {activeSection?.title || learningPlanTitle || 'Lezione'}
                </h2>
              </div>
            </>
          ) : isFocusMode ? (
            <button
              type="button"
              onClick={() => onSetFocusMode(false)}
              className="rounded-md p-1 text-gray-400 transition-all hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
              title="Mostra Menu"
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
              disabled={!activeSection || isLoading}
              className={`inline-flex items-center justify-center rounded-full border transition-colors ${
                isMobileViewport
                  ? 'h-10 w-10'
                  : 'gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em]'
              } ${
                !activeSection || isLoading
                  ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-zinc-500'
                  : 'border-gray-200 bg-white/90 text-gray-700 hover:border-orange-300 hover:text-orange-700 dark:border-zinc-600/80 dark:bg-zinc-800/85 dark:text-zinc-200 dark:hover:border-orange-500/60 dark:hover:text-orange-300'
              }`}
              title={
                activeSection ? 'Rigenera la lezione corrente' : 'Apri una lezione per rigenerarla'
              }
              aria-expanded={isRegenerateConfirmOpen}
              aria-haspopup="dialog"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              {!isMobileViewport ? <span>Rigenera</span> : null}
            </button>

            {isRegenerateConfirmOpen ? (
              <div
                role="dialog"
                aria-label="Conferma rigenerazione lezione"
                className={`${regenerateDialogClassName} rounded-[1.6rem] border border-stone-200/90 bg-white px-4 py-4 text-stone-700 shadow-[0_18px_40px_-24px_rgba(46,34,16,0.32)] dark:border-zinc-600/80 dark:bg-zinc-900 dark:text-zinc-200`}
              >
                <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  Rigenerare questa lezione?
                </p>
                <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-zinc-400">
                  Verrà ricreata la lezione corrente a partire dal materiale sorgente e potresti
                  perdere il contenuto attuale.
                </p>
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsRegenerateConfirmOpen(false)}
                    className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    Annulla
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmRegenerate}
                    className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                  >
                    Rigenera
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <MusicPlayer
            isMobileViewport={isMobileViewport}
            url={musicUrl}
            setUrl={onSetMusicUrl}
            isPlaying={isMusicPlaying}
            setIsPlaying={onSetIsMusicPlaying}
            volume={musicVolume}
            setVolume={onSetMusicVolume}
          />

          {!isMobileViewport ? (
            <>
              <div className="mx-1 h-4 w-px bg-gray-300 dark:bg-zinc-600" />
            </>
          ) : null}

          <button
            type="button"
            onClick={() => onSetSettingsOpen(!isSettingsOpen)}
            onPointerDown={e => e.stopPropagation()}
            className="rounded-full border border-transparent bg-transparent p-2 text-gray-400 transition-colors hover:border-gray-200 hover:bg-gray-100 hover:text-gray-600 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
            title="Apri impostazioni modello"
          >
            <Settings2 className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={() => onSetDarkMode(!isDarkMode)}
            className="rounded-full border border-transparent bg-transparent p-2 text-gray-400 transition-colors hover:border-gray-200 hover:bg-gray-100 hover:text-gray-600 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
            title="Cambia Tema"
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
          modelDefaults={modelDefaults}
          preferredModels={preferredModels}
          onClose={() => onSetSettingsOpen(false)}
          onModelChange={onSetPreferredOpenRouterModel}
        />
      ) : null}
    </header>
  );
}
