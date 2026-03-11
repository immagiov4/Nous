import { BookOpen, Moon, Sun } from 'lucide-react';
import type { ChangeEvent } from 'react';
import type { SavedProjectMeta } from '../types';
import NewProjectPanel from './NewProjectPanel';
import ProjectCard from './ProjectCard';

interface LibraryViewProps {
  isDarkMode: boolean;
  isLibraryLoading: boolean;
  isWorking: boolean;
  loadingStatus: string;
  planFileInputId: string;
  projects: SavedProjectMeta[];
  sourceFileInputId: string;
  storageError: string | null;
  onDeleteProject: (projectId: string) => void;
  onExportProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
  onPlanUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onStartLearnJourney: () => void;
  onToggleDarkMode: () => void;
  onUploadSourceClick: () => void;
  onSourceFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onImportJsonClick: () => void;
}

const LibraryView = ({
  isDarkMode,
  isLibraryLoading,
  isWorking,
  loadingStatus,
  planFileInputId,
  projects,
  sourceFileInputId,
  storageError,
  onDeleteProject,
  onExportProject,
  onOpenProject,
  onPlanUpload,
  onStartLearnJourney,
  onToggleDarkMode,
  onUploadSourceClick,
  onSourceFileUpload,
  onImportJsonClick,
}: LibraryViewProps) => (
  <div className="min-h-screen bg-paper-light px-4 py-5 transition-colors duration-300 dark:bg-paper-dark sm:px-6 lg:px-10">
    <input id={sourceFileInputId} type="file" className="hidden" accept=".pdf,.zip" onChange={onSourceFileUpload} />
    <input id={planFileInputId} type="file" className="hidden" accept=".json" onChange={onPlanUpload} />

    <div className="mx-auto max-w-7xl">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gray-400 dark:text-zinc-500">
            Lumina Deep Reader
          </p>
          <h1 className="max-w-3xl text-5xl font-serif tracking-tight text-gray-900 dark:text-zinc-100 sm:text-6xl">
            I tuoi volumi, percorsi e riletture restano qui.
          </h1>
          <p className="max-w-2xl text-base leading-7 text-gray-500 dark:text-zinc-400">
            Libreria locale con autosave completo. Apri un progetto esistente o avviane uno nuovo.
          </p>
        </div>

        <button
          type="button"
          onClick={onToggleDarkMode}
          className="inline-flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-white"
          aria-label="Cambia tema"
        >
          {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>
      </div>

      {storageError ? (
        <div className="mb-6 rounded-[1.5rem] border border-red-200 bg-red-50/80 px-5 py-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
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

      <section className="mt-10">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-400 dark:text-zinc-500">
              Progetti recenti
            </p>
            <h2 className="mt-2 text-2xl font-serif text-gray-900 dark:text-zinc-100">
              Riprendi da dove avevi lasciato
            </h2>
          </div>
        </div>

        {isLibraryLoading ? (
          <div className="rounded-[2rem] border border-gray-200/80 bg-white/95 p-8 text-sm text-gray-500 dark:border-zinc-800 dark:bg-zinc-900/95 dark:text-zinc-400">
            Caricamento libreria...
          </div>
        ) : null}

        {!isLibraryLoading && projects.length === 0 ? (
          <div className="rounded-[2rem] border border-dashed border-gray-300 bg-white/80 px-8 py-16 text-center dark:border-zinc-800 dark:bg-zinc-900/70">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-gray-100 text-gray-500 dark:bg-zinc-800 dark:text-zinc-300">
              <BookOpen className="h-7 w-7" />
            </div>
            <h3 className="mt-6 text-3xl font-serif text-gray-900 dark:text-zinc-100">
              Nessun progetto salvato
            </h3>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-gray-500 dark:text-zinc-400">
              Carica una fonte o avvia un percorso AI. Da quel momento Lumina salvera automaticamente piano, lezioni e sorgente nel browser.
            </p>
          </div>
        ) : null}

        {!isLibraryLoading && projects.length > 0 ? (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
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

export default LibraryView;
