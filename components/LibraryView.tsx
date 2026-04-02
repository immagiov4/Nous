import { BookOpen, FileJson, Moon, Settings2, Sun } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';
import type {
  HomeChatToolPreferences,
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
  SavedProjectMeta,
} from '../types';
import HomeChatPanel from './HomeChatPanel';
import OpenRouterModelPanel from './OpenRouterModelPanel';
import ProjectCard from './ProjectCard';

interface LibraryViewProps {
  assessmentComplete: boolean;
  assessmentMessages: import('../types').Message[];
  openingProjectId: string | null;
  isDarkMode: boolean;
  isLibraryLoading: boolean;
  isWorking: boolean;
  loadingStatus: string;
  modelDefaults: OpenRouterModelDefaults;
  planFileInputId: string;
  preferredModels: OpenRouterModelPreferences;
  projects: SavedProjectMeta[];
  pendingHomeFileName: string | null;
  sourceFileInputId: string;
  storageError: string | null;
  onClearPendingHomeFile: () => void;
  onConfirmGenerate: () => void;
  onDeleteProject: (projectId: string) => void;
  onExportProject: (projectId: string) => void;
  onHomeChatSubmit: (
    message: string,
    options?: { toolPreferences?: HomeChatToolPreferences }
  ) => Promise<void>;
  onSetPreferredOpenRouterModel: (slot: OpenRouterModelSlot, value: string) => void;
  onOpenProject: (projectId: string) => void;
  onPlanUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onToggleDarkMode: () => void;
  onUploadSourceClick: () => void;
  onSourceFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onImportJsonClick: () => void;
}

const LibraryView = ({
  assessmentComplete,
  assessmentMessages,
  openingProjectId,
  isDarkMode,
  isLibraryLoading,
  isWorking,
  loadingStatus,
  modelDefaults,
  planFileInputId,
  preferredModels,
  projects,
  pendingHomeFileName,
  sourceFileInputId,
  storageError,
  onClearPendingHomeFile,
  onConfirmGenerate,
  onDeleteProject,
  onExportProject,
  onHomeChatSubmit,
  onSetPreferredOpenRouterModel,
  onOpenProject,
  onPlanUpload,
  onToggleDarkMode,
  onUploadSourceClick,
  onSourceFileUpload,
  onImportJsonClick,
}: LibraryViewProps) => {
  const [isModelPanelOpen, setIsModelPanelOpen] = useState(false);
  const projectCountLabel = `${projects.length} ${projects.length === 1 ? 'progetto' : 'progetti'}`;

  return (
    <div className="min-h-screen bg-paper-light px-4 py-5 transition-colors duration-300 dark:bg-paper-dark sm:px-6 lg:px-10">
      <input id={sourceFileInputId} type="file" className="hidden" onChange={onSourceFileUpload} />
      <input
        id={planFileInputId}
        type="file"
        className="hidden"
        accept=".json"
        onChange={onPlanUpload}
      />

      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-serif tracking-[-0.02em] text-gray-900 dark:text-zinc-100 sm:text-4xl">
              Apri un progetto o iniziane uno nuovo.
            </h1>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsModelPanelOpen(currentValue => !currentValue)}
                className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-3.5 py-2.5 text-left text-gray-700 transition-colors hover:border-gray-400 hover:text-gray-900 dark:border-zinc-500/60 dark:bg-paper-surface dark:text-zinc-200 dark:hover:border-zinc-400 dark:hover:text-white"
                aria-label="Apri configurazione modelli AI"
              >
                <Settings2 className="h-4 w-4 flex-shrink-0" />
                <span className="hidden text-sm sm:inline">Modelli</span>
              </button>

              {isModelPanelOpen ? (
                <OpenRouterModelPanel
                  className="fixed left-4 right-4 top-[5.25rem] z-40 sm:absolute sm:left-auto sm:right-0 sm:top-[calc(100%+0.75rem)] sm:w-[min(26rem,calc(100vw-2rem))]"
                  defaultModels={modelDefaults}
                  preferredModels={preferredModels}
                  onClose={() => setIsModelPanelOpen(false)}
                  onModelChange={onSetPreferredOpenRouterModel}
                />
              ) : null}
            </div>

            <button
              type="button"
              onClick={onToggleDarkMode}
              className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-900 dark:border-zinc-500/60 dark:bg-paper-surface dark:text-zinc-400 dark:hover:border-zinc-400 dark:hover:text-white"
              aria-label="Cambia tema"
            >
              {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
          </div>
        </header>

        {storageError ? (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50/90 px-5 py-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            {storageError}
          </div>
        ) : null}

        <HomeChatPanel
          assessmentComplete={assessmentComplete}
          isDarkMode={isDarkMode}
          isLoading={isWorking}
          loadingStatus={loadingStatus}
          messages={assessmentMessages}
          pendingFileName={pendingHomeFileName}
          onClearPendingFile={onClearPendingHomeFile}
          onConfirmGenerate={onConfirmGenerate}
          onSendMessage={onHomeChatSubmit}
          onUploadSourceClick={onUploadSourceClick}
        />

        <section className="mt-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <h2 className="text-2xl font-serif text-gray-900 dark:text-zinc-100">Libreria</h2>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onImportJsonClick}
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-700 dark:border-zinc-600/50 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
                title="Importa backup da file JSON"
              >
                <FileJson className="h-3.5 w-3.5" />
                Importa
              </button>
              <span className="rounded-full border border-gray-200/80 bg-white/85 px-3 py-1.5 text-xs font-medium text-gray-600 dark:border-white/10 dark:bg-paper-surface/85 dark:text-zinc-400">
                {projectCountLabel}
              </span>
            </div>
          </div>

          {isLibraryLoading ? (
            <div className="rounded-[1.4rem] border border-gray-200/80 bg-white/95 p-8 text-sm text-gray-500 dark:border-white/10 dark:bg-paper-surface/95 dark:text-zinc-400">
              Caricamento libreria...
            </div>
          ) : null}

          {!isLibraryLoading && projects.length === 0 ? (
            <div className="rounded-[1.6rem] border border-dashed border-gray-300 bg-white/80 px-8 py-16 text-left dark:border-white/10 dark:bg-paper-surface/70">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-zinc-300">
                <BookOpen className="h-6 w-6" />
              </div>
              <h3 className="mt-6 text-3xl font-serif text-gray-900 dark:text-zinc-100">
                Nessun progetto salvato
              </h3>
            </div>
          ) : null}

          {!isLibraryLoading && projects.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
              {projects.map(project => (
                <ProjectCard
                  key={project.id}
                  isOpening={openingProjectId === project.id}
                  project={project}
                  onDelete={onDeleteProject}
                  onExport={onExportProject}
                  onOpen={onOpenProject}
                />
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};

export default LibraryView;
