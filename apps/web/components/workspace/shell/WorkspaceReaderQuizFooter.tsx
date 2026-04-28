import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

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
  const [hasAttemptedCompletion, setHasAttemptedCompletion] = useState(false);
  const missingPauseMessage =
    remainingQuestionCount === 1
      ? 'Manca 1 pausa attiva: rispondi a quella evidenziata nella lezione.'
      : `Mancano ${remainingQuestionCount} pause attive: completa quelle ancora senza risposta.`;

  const handleCompleteClick = () => {
    if (!canComplete) {
      setHasAttemptedCompletion(true);
      return;
    }

    onCompleteSection();
  };

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
          onClick={handleCompleteClick}
          aria-disabled={!canComplete}
          className={`flex items-center justify-center gap-3 rounded-xl px-8 py-4 font-medium shadow-xl transition-all ${
            canComplete
              ? 'bg-orange-600 text-white shadow-orange-200 hover:-translate-y-1 hover:bg-orange-700 dark:shadow-none'
              : 'cursor-not-allowed bg-stone-300 text-stone-100 shadow-none dark:bg-stone-700 dark:text-stone-400'
          }`}
        >
          Completa e Prosegui <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      {!canComplete && hasAttemptedCompletion ? (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          {missingPauseMessage}
        </p>
      ) : null}
    </div>
  );
}
