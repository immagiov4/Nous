import { ChevronRight } from 'lucide-react';

interface WorkspaceReaderQuizFooterProps {
  canComplete: boolean;
  onCompleteSection: () => void;
  remainingQuestionCount: number;
}

export default function WorkspaceReaderQuizFooter({
  canComplete,
  onCompleteSection,
  remainingQuestionCount,
}: WorkspaceReaderQuizFooterProps) {
  return (
    <div className="mt-12 border-t border-dashed border-gray-200 pt-6 pb-12 dark:border-zinc-700/80">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
          {canComplete
            ? 'Hai completato tutte le pause attive di questa lezione.'
            : remainingQuestionCount === 1
              ? "Rispondi all'ultima pausa attiva per sbloccare la lezione successiva."
              : `Rispondi alle ${remainingQuestionCount} pause attive rimanenti per continuare.`}
        </p>
        <button
          type="button"
          onClick={onCompleteSection}
          disabled={!canComplete}
          className="flex items-center justify-center gap-3 rounded-xl bg-orange-600 px-8 py-4 font-medium text-white shadow-xl shadow-orange-200 transition-all hover:-translate-y-1 hover:bg-orange-700 disabled:cursor-not-allowed disabled:translate-y-0 disabled:bg-stone-300 disabled:text-stone-100 disabled:shadow-none dark:shadow-none dark:disabled:bg-stone-700 dark:disabled:text-stone-400"
        >
          Completa e Prosegui <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
