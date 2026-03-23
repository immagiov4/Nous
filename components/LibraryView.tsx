import { BookOpen, Moon, Settings2, Sun } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';
import type {
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
  SavedProjectMeta,
} from '../types';
import NewProjectPanel from './NewProjectPanel';
import OpenRouterModelPanel from './OpenRouterModelPanel';
import ProjectCard from './ProjectCard';

interface LibraryViewProps {
  openingProjectId: string | null;
  isDarkMode: boolean;
  isLibraryLoading: boolean;
  isWorking: boolean;
  loadingStatus: string;
  modelDefaults: OpenRouterModelDefaults;
  planFileInputId: string;
  preferredModels: OpenRouterModelPreferences;
  projects: SavedProjectMeta[];
  sourceFileInputId: string;
  storageError: string | null;
  onDeleteProject: (projectId: string) => void;
  onExportProject: (projectId: string) => void;
  onSetPreferredOpenRouterModel: (slot: OpenRouterModelSlot, value: string) => void;
  onOpenProject: (projectId: string) => void;
  onPlanUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onStartLearnJourney: () => void;
  onToggleDarkMode: () => void;
  onUploadSourceClick: () => void;
  onSourceFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onImportJsonClick: () => void;
}

const LibraryView = ({
  openingProjectId,
  isDarkMode,
  isLibraryLoading,
  isWorking,
  loadingStatus,
  modelDefaults,
  planFileInputId,
  preferredModels,
  projects,
  sourceFileInputId,
  storageError,
  onDeleteProject,
  onExportProject,
  onSetPreferredOpenRouterModel,
  onOpenProject,
  onPlanUpload,
  onStartLearnJourney,
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
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="max-w-4xl space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500 dark:text-zinc-500">
              <span className="rounded-full border border-gray-200/80 bg-white/80 px-3 py-1 text-gray-700 dark:border-white/10 dark:bg-zinc-900/80 dark:text-zinc-300">
                Lumina Deep Reader
              </span>
              <span>{projectCountLabel}</span>
            </div>

            <h1 className="max-w-4xl text-4xl font-serif tracking-[-0.03em] text-gray-900 dark:text-zinc-100 sm:text-5xl">
              Apri un progetto o iniziane uno nuovo.
            </h1>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsModelPanelOpen(currentValue => !currentValue)}
                className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-left text-gray-700 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:text-white"
                aria-label="Apri configurazione modelli AI"
              >
                <Settings2 className="h-4 w-4 flex-shrink-0" />
                <div className="hidden sm:block">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-500">
                    AI Routing
                  </p>
                  <p className="text-sm text-gray-900 dark:text-zinc-100">Modelli</p>
                </div>
              </button>

              {isModelPanelOpen ? (
                <OpenRouterModelPanel
                  className="absolute right-0 top-[calc(100%+0.75rem)] z-30 w-[min(26rem,calc(100vw-2rem))]"
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
              className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-white"
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

        <NewProjectPanel
          isLoading={isWorking}
          loadingStatus={loadingStatus}
          onImportJsonClick={onImportJsonClick}
          onLearnModeClick={onStartLearnJourney}
          onUploadSourceClick={onUploadSourceClick}
        />

        <section className="mt-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-serif text-gray-900 dark:text-zinc-100">Recenti</h2>
            </div>
            <div className="rounded-full border border-gray-200/80 bg-white/85 px-3 py-1.5 text-xs font-medium text-gray-600 dark:border-white/10 dark:bg-zinc-900/85 dark:text-zinc-400">
              {projectCountLabel}
            </div>
          </div>

          {isLibraryLoading ? (
            <div className="rounded-[1.4rem] border border-gray-200/80 bg-white/95 p-8 text-sm text-gray-500 dark:border-white/10 dark:bg-zinc-900/95 dark:text-zinc-400">
              Caricamento libreria...
            </div>
          ) : null}

          {!isLibraryLoading && projects.length === 0 ? (
            <div className="rounded-[1.6rem] border border-dashed border-gray-300 bg-white/80 px-8 py-16 text-left dark:border-white/10 dark:bg-zinc-900/70">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-zinc-300">
                <BookOpen className="h-6 w-6" />
              </div>
              <h3 className="mt-6 text-3xl font-serif text-gray-900 dark:text-zinc-100">
                Nessun progetto salvato
              </h3>
            </div>
          ) : null}

          {!isLibraryLoading && projects.length > 0 ? (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
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
