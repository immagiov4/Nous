import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { QuizQuestion } from '../../../types.ts';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';
import {
  QUIZ_FRAME,
  QUIZ_OPTION,
  QUIZ_TOPIC,
  QUIZ_UNANSWERED_FRAME,
  QUIZ_UNANSWERED_OPTION,
  QuizOptionContent,
} from '../../shared/QuizPresentation.tsx';

interface WorkspaceReaderInlineQuestionProps {
  readonly isDarkMode: boolean;
  readonly onSelectQuizAnswer: (questionIndex: number, optionIndex: number) => void;
  readonly question: QuizQuestion;
  readonly questionIndex: number;
  readonly selectedIndex: number;
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

  return QUIZ_UNANSWERED_OPTION;
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

  return (
    <section
      data-nous-speech="ignore"
      className={`my-8 ${QUIZ_FRAME} ${
        isAnswered
          ? 'border-stone-200/90 bg-stone-50/90 dark:border-stone-600/80 dark:bg-stone-900/50'
          : QUIZ_UNANSWERED_FRAME
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className={QUIZ_TOPIC}>
          {t('Pausa attiva {questionNumber}', {
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
          {question.explanation ? (
            <MarkdownRenderer
              content={question.explanation}
              isDarkMode={isDarkMode}
              className="prose-sm max-w-none [&>p]:m-0"
            />
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {question.options.map((option, optionIndex) => (
            <button
              type="button"
              // biome-ignore lint/suspicious/noArrayIndexKey: generated options have no IDs and may contain duplicate text; their order is immutable for the lifetime of this quiz.
              key={`${questionIndex}-${optionIndex}`}
              onClick={() => onSelectQuizAnswer(questionIndex, optionIndex)}
              className={`${QUIZ_OPTION} ${getQuizOptionClassName({
                correctIndex: question.correctIndex,
                isAnswered,
                optionIndex,
                selectedIndex,
              })}`}
            >
              <QuizOptionContent index={optionIndex} text={option} isDarkMode={isDarkMode} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
