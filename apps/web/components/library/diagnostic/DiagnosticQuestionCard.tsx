import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import {
  QUIZ_OPTION,
  QUIZ_TOPIC,
  QUIZ_UNANSWERED_OPTION,
  QuizOptionContent,
} from '../../shared/QuizPresentation.tsx';
import type { DiagnosticAnswer, DiagnosticQuestion } from './diagnosticFlow.ts';

interface Props {
  readonly isDarkMode?: boolean;
  readonly question: DiagnosticQuestion;
  readonly answer?: DiagnosticAnswer;
  readonly onAnswer: (answer: DiagnosticAnswer) => void;
}
/** Uses the lesson quiz visual grammar without disclosing correctness during collection. */
export default function DiagnosticQuestionCard({ question, answer, onAnswer, isDarkMode }: Props) {
  return (
    <div>
      <div className="mb-3 flex">
        <span className={QUIZ_TOPIC}>{question.topic}</span>
      </div>
      <p
        id={`diagnostic-prompt-${question.id}`}
        className="text-base leading-relaxed text-gray-800 dark:text-gray-100"
      >
        {question.prompt}
      </p>
      {question.format === 'text' ? (
        <textarea
          aria-labelledby={`diagnostic-prompt-${question.id}`}
          value={answer?.kind === 'text' ? answer.text : ''}
          placeholder={t('Scrivi la tua risposta...')}
          onChange={event => onAnswer({ kind: 'text', text: event.target.value })}
          className="mt-4 min-h-40 w-full resize-y rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4 text-base"
        />
      ) : (
        <fieldset className="mt-4 space-y-3">
          <legend className="sr-only">{question.prompt}</legend>
          {question.options.map((option, index) => (
            <label
              key={option.id}
              className={`diagnostic-option ${QUIZ_OPTION} ${QUIZ_UNANSWERED_OPTION}`}
            >
              <input
                type="radio"
                name={question.id}
                checked={answer?.kind === 'choice' && answer.optionId === option.id}
                onChange={() => onAnswer({ kind: 'choice', optionId: option.id })}
              />
              <QuizOptionContent index={index} text={option.text} isDarkMode={isDarkMode} />
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
