import { BrainCircuit, FileJson, FolderUp } from 'lucide-react';

interface NewProjectPanelProps {
  isLoading: boolean;
  loadingStatus: string;
  onImportJsonClick: () => void;
  onLearnModeClick: () => void;
  onUploadSourceClick: () => void;
}

const NewProjectPanel = ({
  isLoading,
  loadingStatus,
  onImportJsonClick,
  onLearnModeClick,
  onUploadSourceClick,
}: NewProjectPanelProps) => (
  <section className="space-y-4">
    {isLoading ? (
      <div className="inline-flex items-center gap-3 rounded-full border border-orange-200 bg-orange-50 px-4 py-2 text-sm text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300">
        <span className="h-2 w-2 animate-pulse rounded-full bg-orange-500" />
        {loadingStatus}
      </div>
    ) : null}

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <button
        type="button"
        onClick={onUploadSourceClick}
        className="group flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-5 text-left transition-all hover:border-gray-300 hover:shadow-sm dark:border-white/10 dark:bg-zinc-900 dark:hover:border-zinc-700"
      >
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gray-900 text-white dark:bg-white dark:text-black">
          <FolderUp className="h-5 w-5" />
        </div>
        <div>
          <p className="text-base font-medium text-gray-900 dark:text-zinc-100">Nuovo progetto</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-zinc-400">Da file PDF o ZIP</p>
        </div>
      </button>

      <button
        type="button"
        onClick={onLearnModeClick}
        className="group flex items-center gap-4 rounded-2xl border border-orange-200/80 bg-orange-50/70 p-5 text-left transition-all hover:border-orange-300 hover:shadow-sm dark:border-orange-900/40 dark:bg-orange-950/20 dark:hover:border-orange-800"
      >
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-orange-600 text-white">
          <BrainCircuit className="h-5 w-5" />
        </div>
        <div>
          <p className="text-base font-medium text-gray-900 dark:text-zinc-100">Percorso AI</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-zinc-400">Impara senza file</p>
        </div>
      </button>

      <button
        type="button"
        onClick={onImportJsonClick}
        className="group flex items-center gap-4 rounded-2xl border border-dashed border-gray-200 bg-white/60 p-5 text-left transition-all hover:border-gray-300 hover:bg-white hover:shadow-sm sm:col-span-2 lg:col-span-1 dark:border-white/10 dark:bg-zinc-900/60 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
      >
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-300">
          <FileJson className="h-5 w-5" />
        </div>
        <div>
          <p className="text-base font-medium text-gray-900 dark:text-zinc-100">Importa backup</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-zinc-400">Da file JSON esportato</p>
        </div>
      </button>
    </div>
  </section>
);

export default NewProjectPanel;
