import {
  ArrowLeft,
  Moon,
  RefreshCw,
  Settings2,
  SidebarOpen,
  Sun,
  X,
} from 'lucide-react';
import MusicPlayer from '../MusicPlayer.tsx';
import WorkspaceReaderSettingsPanel from './WorkspaceReaderSettingsPanel.tsx';
import type { WorkspaceReaderHeaderModel } from './types.ts';

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
  return (
    <header
      className={`
        sticky top-0 relative z-50 flex flex-shrink-0 items-center justify-between overflow-visible border-b border-gray-100 bg-white/80 backdrop-blur transition-opacity duration-500 ease-in-out dark:border-zinc-700/80 dark:bg-zinc-800/80
        ${isMobileViewport ? 'min-h-[4.5rem] gap-3 px-4 py-3' : 'h-16 px-8'}
        opacity-100
      `}
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
              {isMobileSidebarOpen ? <X className="h-4 w-4" /> : <SidebarOpen className="h-4 w-4" />}
            </button>
            <div className="min-w-0">
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

      <div className={`flex shrink-0 items-center ${isMobileViewport ? 'gap-3' : 'gap-6'}`}>
        {isLoading ? (
          <div
            className={`flex animate-pulse items-center gap-2 rounded-full bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400 ${
              isMobileViewport
                ? 'px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]'
                : 'px-4 py-1.5 text-xs font-bold'
            }`}
          >
            <span className="h-2 w-2 rounded-full bg-orange-500" />
            {isMobileViewport ? 'Carica' : loadingStatus.toUpperCase()}
          </div>
        ) : null}

        <button
          type="button"
          onClick={onRegenerateActiveSection}
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
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          {!isMobileViewport ? <span>Rigenera</span> : null}
        </button>

        {!isMobileViewport ? (
          <>
            <MusicPlayer
              url={musicUrl}
              setUrl={onSetMusicUrl}
              isPlaying={isMusicPlaying}
              setIsPlaying={onSetIsMusicPlaying}
              volume={musicVolume}
              setVolume={onSetMusicVolume}
            />
            <div className="mx-1 h-4 w-px bg-gray-300 dark:bg-zinc-600" />
          </>
        ) : null}

        <button
          type="button"
          onClick={() => onSetSettingsOpen(!isSettingsOpen)}
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
