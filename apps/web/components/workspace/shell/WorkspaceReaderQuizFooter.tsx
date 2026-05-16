import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface WorkspaceReaderQuizFooterProps {
  canComplete: boolean;
  hasNextSection: boolean;
  onAdvanceSection: () => void;
  onCompleteSection: () => void;
  remainingQuestionCount: number;
}

export default function WorkspaceReaderQuizFooter({
  canComplete,
  hasNextSection,
  onAdvanceSection,
  onCompleteSection,
  remainingQuestionCount,
}: WorkspaceReaderQuizFooterProps) {
  const [hasAttemptedCompletion, setHasAttemptedCompletion] = useState(false);
  const canAdvance = canComplete || hasNextSection;
  const missingPauseMessage =
    remainingQuestionCount === 1
      ? 'Manca 1 pausa attiva: rispondi a quella evidenziata nella lezione.'
      : `Mancano ${remainingQuestionCount} pause attive: completa quelle ancora senza risposta.`;

  const handleCompleteClick = () => {
    if (canComplete) {
      onCompleteSection();
      return;
    }

    if (hasNextSection) {
      onAdvanceSection();
      return;
    }

    if (!canAdvance) {
      setHasAttemptedCompletion(true);
    }
  };

  return (
    <div className="mt-12 border-t border-dashed border-gray-200 pt-6 pb-12 dark:border-zinc-700/80">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
          {canComplete
            ? 'Hai completato tutte le pause attive di questa lezione.'
            : hasNextSection
              ? 'Puoi andare avanti subito oppure completare prima le pause attive per segnare la lezione come completata.'
              : remainingQuestionCount === 1
                ? "Rispondi all'ultima pausa attiva per completare la lezione."
                : `Rispondi alle ${remainingQuestionCount} pause attive rimanenti per completare la lezione.`}
        </p>
        <button
          type="button"
          onClick={handleCompleteClick}
          aria-disabled={!canAdvance}
          className={`flex items-center justify-center gap-3 rounded-xl border px-8 py-4 font-medium transition-colors ${
            canComplete
              ? 'border-stone-900 bg-stone-900 text-white hover:bg-stone-800 dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white'
              : canAdvance
                ? 'border-gray-300 bg-white text-gray-800 hover:border-gray-400 hover:bg-gray-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500 dark:hover:bg-zinc-800'
                : 'cursor-not-allowed border-stone-300 bg-stone-300 text-stone-100 dark:border-stone-700 dark:bg-stone-700 dark:text-stone-400'
          }`}
        >
          {canComplete ? 'Completa e Prosegui' : 'Prosegui'} <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      {!canAdvance && hasAttemptedCompletion ? (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          {missingPauseMessage}
        </p>
      ) : null}
    </div>
  );
}
