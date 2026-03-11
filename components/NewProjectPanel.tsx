import { ArrowUpRight, BrainCircuit, FileJson, FolderUp } from 'lucide-react';

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
  <section className="rounded-[2.25rem] border border-gray-200/80 bg-white/95 p-8 shadow-[0_28px_90px_-40px_rgba(30,41,59,0.28)] dark:border-zinc-800 dark:bg-zinc-900/95">
    <div className="max-w-2xl space-y-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-400 dark:text-zinc-500">
        Libreria locale
      </p>
      <div className="space-y-3">
        <h2 className="text-4xl font-serif leading-tight text-gray-900 dark:text-zinc-100">
          Apri, riprendi o genera un nuovo percorso senza perdere nulla.
        </h2>
        <p className="max-w-xl text-base leading-7 text-gray-500 dark:text-zinc-400">
          Ogni progetto viene salvato automaticamente nel browser con sorgente, piano e lezioni gia generate.
        </p>
      </div>
    </div>

    <div className="mt-10 grid gap-4 lg:grid-cols-[1.2fr_0.9fr_0.9fr]">
      <button
        type="button"
        onClick={onUploadSourceClick}
        className="group flex min-h-[14rem] flex-col justify-between rounded-[2rem] border border-gray-200 bg-gray-50/70 p-6 text-left transition-all hover:-translate-y-1 hover:border-gray-300 hover:bg-white dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-900 text-white dark:bg-white dark:text-black">
          <FolderUp className="h-6 w-6" />
        </div>
        <div className="space-y-2">
          <p className="text-2xl font-serif text-gray-900 dark:text-zinc-100">Nuovo progetto</p>
          <p className="text-sm leading-6 text-gray-500 dark:text-zinc-400">
            Carica un PDF o uno ZIP, poi lascia che Lumina costruisca e salvi il percorso.
          </p>
        </div>
      </button>

      <button
        type="button"
        onClick={onImportJsonClick}
        className="group flex min-h-[14rem] flex-col justify-between rounded-[2rem] border border-gray-200 bg-white p-6 text-left transition-all hover:-translate-y-1 hover:border-gray-300 dark:border-zinc-800 dark:bg-zinc-950/70 dark:hover:border-zinc-700"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-zinc-300">
          <FileJson className="h-6 w-6" />
        </div>
        <div className="space-y-2">
          <p className="text-xl font-serif text-gray-900 dark:text-zinc-100">Importa backup</p>
          <p className="text-sm leading-6 text-gray-500 dark:text-zinc-400">
            Riporta dentro un export `.json` completo o legacy.
          </p>
        </div>
      </button>

      <button
        type="button"
        onClick={onLearnModeClick}
        className="group flex min-h-[14rem] flex-col justify-between rounded-[2rem] border border-orange-200/70 bg-orange-50/80 p-6 text-left transition-all hover:-translate-y-1 hover:border-orange-300 dark:border-orange-900/60 dark:bg-orange-950/25"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-600 text-white">
          <BrainCircuit className="h-6 w-6" />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-orange-700 dark:text-orange-300">
            <span className="text-[11px] font-semibold uppercase tracking-[0.22em]">AI</span>
            <ArrowUpRight className="h-4 w-4" />
          </div>
          <p className="text-xl font-serif text-gray-900 dark:text-zinc-100">Impara qualcosa di nuovo</p>
          <p className="text-sm leading-6 text-gray-600 dark:text-zinc-300">
            Crea un percorso nativo AI senza file sorgente.
          </p>
        </div>
      </button>
    </div>

    {isLoading ? (
      <div className="mt-6 inline-flex items-center gap-3 rounded-full bg-orange-50 px-4 py-2 text-sm text-orange-700 dark:bg-orange-950/40 dark:text-orange-300">
        <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse"></span>
        {loadingStatus}
      </div>
    ) : null}
  </section>
);

export default NewProjectPanel;
