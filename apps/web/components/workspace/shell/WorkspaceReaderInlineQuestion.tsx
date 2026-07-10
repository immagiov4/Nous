import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { QuizQuestion } from '../../../types.ts';
import { getActivePauseExerciseLabel } from '../../../utils/learning/activePause.ts';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';

interface WorkspaceReaderInlineQuestionProps {
  isDarkMode: boolean;
  onSelectQuizAnswer: (questionIndex: number, optionIndex: number) => void;
  question: QuizQuestion;
  questionIndex: number;
  selectedIndex: number;
}

const getQuizOptionClassName = ({
  correctIndex,
  isAnswered,
  optionIndex,
  selectedIndex,
}: {
  correctIndex: number;
  isAnswered: boolean;
  optionIndex: number;
  selectedIndex: number;
}) => {
  if (isAnswered) {
    if (optionIndex === correctIndex) {
      return 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300';
    }

    if (selectedIndex === optionIndex) {
      return 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300';
    }

    return 'border-transparent bg-gray-50 opacity-60 dark:bg-zinc-800';
  }

  return 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-gray-300 dark:hover:bg-zinc-700';
};

export default function WorkspaceReaderInlineQuestion({
  isDarkMode,
  onSelectQuizAnswer,
  question,
  questionIndex,
  selectedIndex,
}: WorkspaceReaderInlineQuestionProps) {
  const isAnswered = selectedIndex >= 0;
  const selectedOption = isAnswered ? question.options[selectedIndex] : '';
  const correctOption = question.options[question.correctIndex] || '';
  const answeredCorrectly = selectedIndex === question.correctIndex;
  const exerciseLabel = getActivePauseExerciseLabel(question);

  return (
    <section
      className={`my-8 rounded-[2rem] border px-5 py-5 shadow-sm transition-all sm:px-7 ${
        isAnswered
          ? 'border-stone-200/90 bg-stone-50/90 dark:border-stone-600/80 dark:bg-stone-900/50'
          : 'border-orange-200/80 bg-white/95 dark:border-orange-700/60 dark:bg-zinc-900/85'
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="rounded-full bg-orange-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
          {t('Pausa attiva {questionNumber} - {exerciseLabel}', {
            exerciseLabel,
            questionNumber: questionIndex + 1,
          })}
        </span>
        {isAnswered ? (
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              answeredCorrectly
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
            }`}
          >
            {t(answeredCorrectly ? 'Corretta' : 'Da rivedere')}
          </span>
        ) : null}
      </div>

      <div className="text-base text-gray-800 dark:text-gray-100">
        <MarkdownRenderer
          content={question.question}
          isDarkMode={isDarkMode}
          className="prose-base max-w-none [&>p]:m-0"
        />
      </div>

      {isAnswered ? (
        <div className="mt-4 grid gap-3 rounded-2xl border border-stone-200/80 bg-white/80 px-4 py-4 text-sm text-stone-700 dark:border-stone-700/70 dark:bg-zinc-900/70 dark:text-stone-200">
          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500 dark:text-stone-400">
              {t('La tua scelta')}
            </span>
            <MarkdownRenderer
              content={selectedOption}
              isDarkMode={isDarkMode}
              className="prose-sm max-w-none [&>p]:m-0"
            />
          </div>
          {!answeredCorrectly ? (
            <div>
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500 dark:text-stone-400">
                {t('Risposta corretta')}
              </span>
              <MarkdownRenderer
                content={correctOption}
                isDarkMode={isDarkMode}
                className="prose-sm max-w-none [&>p]:m-0"
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {question.options.map((option, optionIndex) => (
            <button
              type="button"
              key={`${question.question}-${option}`}
              onClick={() => onSelectQuizAnswer(questionIndex, optionIndex)}
              className={`flex w-full items-baseline gap-2 rounded-xl border p-4 text-left text-base transition-all ${getQuizOptionClassName(
                {
                  correctIndex: question.correctIndex,
                  isAnswered,
                  optionIndex,
                  selectedIndex,
                }
              )}`}
            >
              <span className="mr-2 inline-block w-6 shrink-0 font-bold opacity-40">
                {String.fromCharCode(65 + optionIndex)}.
              </span>
              <span className="min-w-0 flex-1">
                <MarkdownRenderer
                  content={option}
                  isDarkMode={isDarkMode}
                  className="prose-sm max-w-none [&_p]:!my-0"
                />
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
