import { ChevronRight, GraduationCap } from 'lucide-react';
import type { QuizQuestion } from '../../../types.ts';
import { getActivePauseExerciseLabel } from '../../../utils/learning/activePause.ts';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';

interface WorkspaceReaderQuizProps {
  isQuizSubmitted: boolean;
  onCompleteSection: () => void;
  onSelectQuizAnswer: (questionIndex: number, optionIndex: number) => void;
  onSetIsQuizSubmitted: (value: boolean) => void;
  quiz: QuizQuestion[];
  quizAnswers: number[];
}

const getQuizOptionClassName = ({
  correctIndex,
  isQuizSubmitted,
  optionIndex,
  selectedIndex,
}: {
  correctIndex: number;
  isQuizSubmitted: boolean;
  optionIndex: number;
  selectedIndex: number | undefined;
}) => {
  if (isQuizSubmitted) {
    if (optionIndex === correctIndex) {
      return 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300';
    }

    if (selectedIndex === optionIndex) {
      return 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300';
    }

    return 'border-transparent bg-gray-50 opacity-50 dark:bg-zinc-800';
  }

  if (selectedIndex === optionIndex) {
    return 'border-orange-300 bg-orange-50 text-orange-900 shadow-sm dark:border-orange-700 dark:bg-orange-900/10 dark:text-orange-300';
  }

  return 'border-gray-100 bg-white text-gray-600 hover:bg-gray-50 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-gray-400 dark:hover:bg-zinc-700';
};

export default function WorkspaceReaderQuiz({
  isQuizSubmitted,
  onCompleteSection,
  onSelectQuizAnswer,
  onSetIsQuizSubmitted,
  quiz,
  quizAnswers,
}: WorkspaceReaderQuizProps) {
  return (
    <div className="mt-10 border-t-2 border-dashed border-gray-200 pt-6 dark:border-zinc-700/80">
      <div className="mb-8 flex items-center gap-3">
        <div className="rounded-lg bg-orange-100 p-2 text-orange-600 dark:bg-orange-900/20 dark:text-orange-400">
          <GraduationCap className="h-6 w-6" />
        </div>
        <h3 className="font-serif text-2xl text-gray-900 dark:text-gray-100">
          Verifica Comprensione
        </h3>
      </div>

      <div className="grid gap-6">
        {quiz.map((question, questionIndex) => (
          <div
            key={question.question}
            className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm transition-all hover:shadow-md dark:border-zinc-700/80 dark:bg-zinc-800"
          >
            <div className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-orange-700 dark:text-orange-300">
              Pausa attiva {questionIndex + 1} - {getActivePauseExerciseLabel(question)}
            </div>
            <div className="mb-6 font-serif text-lg font-medium text-gray-800 dark:text-gray-200">
              <MarkdownRenderer content={question.question} className="prose-lg max-w-none" />
            </div>
            <div className="space-y-3">
              {question.options.map((option, optionIndex) => (
                <button
                  type="button"
                  key={`${question.question}-${option}`}
                  onClick={() => onSelectQuizAnswer(questionIndex, optionIndex)}
                  className={`flex w-full items-baseline gap-2 rounded-xl border-2 p-4 text-left text-base transition-all ${getQuizOptionClassName(
                    {
                      correctIndex: question.correctIndex,
                      isQuizSubmitted,
                      optionIndex,
                      selectedIndex: quizAnswers[questionIndex],
                    }
                  )}`}
                >
                  <span className="mr-2 inline-block w-6 shrink-0 font-bold opacity-40">
                    {String.fromCharCode(65 + optionIndex)}.
                  </span>
                  <span className="min-w-0 flex-1">
                    <MarkdownRenderer content={option} className="prose-sm max-w-none [&>p]:m-0" />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-12 flex justify-end pb-12">
        {!isQuizSubmitted ? (
          <button
            type="button"
            onClick={() => onSetIsQuizSubmitted(true)}
            disabled={quizAnswers.includes(-1)}
            className="transform rounded-xl bg-gray-900 px-8 py-4 font-medium text-white shadow-lg transition-colors hover:-translate-y-0.5 hover:bg-black hover:shadow-xl disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-gray-200"
          >
            Controlla Risposte
          </button>
        ) : (
          <button
            type="button"
            onClick={onCompleteSection}
            className="flex items-center gap-3 rounded-xl bg-orange-600 px-10 py-4 font-medium text-white shadow-xl shadow-orange-200 transition-all hover:-translate-y-1 hover:bg-orange-700 dark:shadow-none"
          >
            Completa e Prosegui <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}
