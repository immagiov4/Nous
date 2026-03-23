import { BrainCircuit, FileJson, Paperclip, Plus } from 'lucide-react';
import { useState } from 'react';

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
}: NewProjectPanelProps) => {
  const [hasFile, setHasFile] = useState(false);

  const handleStart = () => {
    if (hasFile) {
      onUploadSourceClick();
    } else {
      onLearnModeClick();
    }
  };

  return (
    <section className="space-y-4">
      {isLoading ? (
        <div className="inline-flex items-center gap-3 rounded-full border border-orange-200 bg-orange-50 px-4 py-2 text-sm text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-orange-500" />
          {loadingStatus}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white p-2 dark:border-zinc-600/60 dark:bg-zinc-900">
          <button
            type="button"
            onClick={() => setHasFile(current => !current)}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-all ${
              hasFile
                ? 'bg-gray-900 text-white shadow-sm dark:bg-white dark:text-black'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'
            }`}
            title={hasFile ? 'Rimuovi file — passa a Percorso AI' : 'Allega file sorgente'}
          >
            {hasFile ? (
              <>
                <Paperclip className="h-4 w-4 -rotate-45" />
                <span className="hidden sm:inline">File allegato</span>
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">Allega file</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleStart}
            className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-5 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-black dark:bg-white dark:text-black dark:hover:bg-gray-200"
          >
            <BrainCircuit className="h-4 w-4" />
            <span>{hasFile ? 'Nuovo progetto' : 'Percorso AI'}</span>
          </button>
        </div>

        <button
          type="button"
          onClick={onImportJsonClick}
          className="inline-flex h-[3.25rem] w-[3.25rem] flex-shrink-0 items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-white/60 text-gray-400 transition-all hover:border-gray-400 hover:bg-white hover:text-gray-600 dark:border-zinc-600/60 dark:bg-zinc-900/60 dark:text-zinc-500 dark:hover:border-zinc-500 dark:hover:text-zinc-300"
          title="Importa backup da file JSON"
        >
          <FileJson className="h-5 w-5" />
        </button>
      </div>
    </section>
  );
};

export default NewProjectPanel;
