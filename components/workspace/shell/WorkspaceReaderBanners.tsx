import type { WorkspaceReaderBannersModel } from './types.ts';

export default function WorkspaceReaderBanners({
  needsSourceFile,
  onAttachSourceFile,
  onBackToLibrary,
  onExportProject,
  storageError,
}: WorkspaceReaderBannersModel) {
  return (
    <>
      {storageError ? (
        <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-red-200 bg-red-50/80 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300 sm:mx-8 sm:mt-5">
          <span>{storageError}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onExportProject}
              className="inline-flex items-center justify-center rounded-full border border-red-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700 transition-colors hover:bg-red-100 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/60"
            >
              Esporta
            </button>
            <button
              type="button"
              onClick={onBackToLibrary}
              className="inline-flex items-center justify-center rounded-full border border-red-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700 transition-colors hover:bg-red-100 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/60"
            >
              Libreria
            </button>
          </div>
        </div>
      ) : null}

      {needsSourceFile ? (
        <div className="mx-4 mt-4 flex flex-col items-start justify-between gap-4 rounded-2xl border border-gray-200 bg-white/90 px-4 py-3 text-sm text-gray-600 dark:border-zinc-700/80 dark:bg-zinc-800/90 dark:text-zinc-300 sm:mx-8 sm:mt-5 sm:flex-row sm:items-center">
          <span>
            Questo progetto e stato importato senza file sorgente. Ricollega il PDF o lo ZIP per
            generare nuove lezioni.
          </span>
          <button
            type="button"
            onClick={onAttachSourceFile}
            className="inline-flex items-center justify-center rounded-full bg-gray-900 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-black dark:bg-white dark:text-black dark:hover:bg-gray-200"
          >
            Ricollega sorgente
          </button>
        </div>
      ) : null}
    </>
  );
}
