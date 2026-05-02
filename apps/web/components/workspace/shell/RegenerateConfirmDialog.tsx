import { MotionPopover } from '../../../utils/motion/index.ts';

interface RegenerateConfirmDialogProps {
  isMobileViewport: boolean;
  isOpen: boolean;
  subjectLabel: string;
  demonstrative: string;
  isLaboratory: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export const RegenerateConfirmDialog = ({
  isMobileViewport,
  isOpen,
  subjectLabel,
  demonstrative,
  isLaboratory,
  onConfirm,
  onClose,
}: RegenerateConfirmDialogProps) => {
  const dialogClassName = isMobileViewport
    ? 'mx-auto w-[min(20rem,calc(100vw-2rem))]'
    : 'absolute right-0 top-[calc(100%+0.75rem)] z-50 w-[min(20rem,calc(100vw-2rem))]';

  const content = (
    <div
      className={`${dialogClassName} panel-shadow rounded-2xl border border-gray-200 bg-white px-4 py-4 text-stone-700 dark:border-zinc-600/80 dark:bg-[var(--bg-surface)] dark:text-zinc-200`}
    >
      <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        {`Rigenerare ${demonstrative} ${subjectLabel}?`}
      </p>
      <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-zinc-400">
        {isLaboratory
          ? 'La traccia verrà riscritta e gli allegati correnti potrebbero non essere più coerenti con la nuova consegna.'
          : 'Verrà ricreata la lezione corrente a partire dal materiale sorgente e potresti perdere il contenuto attuale.'}
      </p>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          Annulla
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
        >
          Rigenera
        </button>
      </div>
    </div>
  );

  if (isMobileViewport) {
    return (
      <div
        className="fixed bottom-0 left-1/2 top-0 z-50 flex w-full -translate-x-1/2 items-start justify-center pt-24"
        role="dialog"
        aria-label="Conferma rigenerazione contenuto"
      >
        {content}
      </div>
    );
  }

  return (
    <MotionPopover
      isOpen={isOpen}
      originX="top right"
      role="dialog"
      aria-label="Conferma rigenerazione contenuto"
      className={dialogClassName}
    >
      {content}
    </MotionPopover>
  );
};
