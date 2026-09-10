import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import { useLayoutEffect, useReducer, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import DiagnosticQuestionCard from './DiagnosticQuestionCard.tsx';
import DiagnosticTree from './DiagnosticTree.tsx';
import {
  buildDiagnosticSubmission,
  type DiagnosticAdapter,
  type DiagnosticAnswer,
  DiagnosticStoppedError,
  diagnosticItems,
  diagnosticReducer,
  initialDiagnosticState,
} from './diagnosticFlow.ts';
import './diagnostic.css';

export interface DiagnosticFlowProps {
  readonly adapter: DiagnosticAdapter;
  readonly isDarkMode?: boolean;
}

/** Mount with the collection identity as key. The adapter determines every accepted next stage. */
export default function DiagnosticFlow({ adapter, isDarkMode }: DiagnosticFlowProps) {
  const [completionError, setCompletionError] = useState(false);
  const [openingCourse, setOpeningCourse] = useState(false);
  const [state, dispatch] = useReducer(diagnosticReducer, adapter.initial, initialDiagnosticState);
  const request = useRef<{
    answers: typeof state.answers;
    submission: ReturnType<typeof buildDiagnosticSubmission>;
  } | null>(null);
  const inFlight = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { stage, position, status } = state;
  const focusKey = `${stage.id}:${position}`;
  const previousFocusKey = useRef(focusKey);
  const busy = status === 'submitting';
  useLayoutEffect(() => {
    if (previousFocusKey.current === focusKey) return;
    previousFocusKey.current = focusKey;
    titleRef.current?.focus();
  }, [focusKey]);
  const items = diagnosticItems(stage);
  const answer = (itemId: string, next: DiagnosticAnswer) =>
    dispatch({ type: 'answer', itemId, answer: next });
  const submit = async () => {
    if (inFlight.current || stage.kind === 'complete') return;
    inFlight.current = true;
    if (request.current?.answers !== state.answers) {
      request.current = {
        answers: state.answers,
        submission: buildDiagnosticSubmission(state, adapter.collectionId, crypto.randomUUID()),
      };
    }
    dispatch({ type: 'submit' });
    try {
      const nextStage = await adapter.submit(request.current.submission);
      request.current = null;
      dispatch({ type: 'accepted', stage: nextStage });
    } catch (error) {
      console.error('Diagnostic submission failed', error);
      dispatch({ type: error instanceof DiagnosticStoppedError ? 'stopped' : 'failed' });
    } finally {
      inFlight.current = false;
    }
  };
  const currentQuestion = stage.kind === 'round' ? stage.questions[position] : undefined;
  let nextLabel = t('Invia le risposte');
  if (stage.kind === 'self-assessment') nextLabel = t('Continua');
  else if (stage.kind === 'round' && position < items.length - 1) nextLabel = t('Successiva');
  return (
    <section className="diagnostic-flow" aria-label={t('Conoscenze iniziali')} aria-busy={busy}>
      <h2 ref={titleRef} tabIndex={-1} className="mb-6 text-xl font-semibold outline-none">
        {stage.title}
        {stage.kind === 'round' && (
          <span className="ml-3 whitespace-nowrap text-sm font-normal text-[var(--ink-secondary)]">
            {position + 1} / {items.length}
          </span>
        )}
      </h2>
      {stage.kind === 'complete' ? (
        <>
          <p className="whitespace-pre-wrap leading-relaxed">{stage.feedback}</p>
          {adapter.onComplete && (
            <button
              type="button"
              className="diagnostic-primary mt-4"
              disabled={openingCourse}
              onClick={async () => {
                setOpeningCourse(true);
                setCompletionError(false);
                try {
                  await adapter.onComplete?.();
                } catch {
                  setCompletionError(true);
                } finally {
                  setOpeningCourse(false);
                }
              }}
            >
              {t('Continua')}
            </button>
          )}
          {completionError && (
            <p role="alert">
              {t('La richiesta non è disponibile in questo momento. Riprova più tardi.')}
            </p>
          )}
        </>
      ) : (
        <>
          <fieldset disabled={status !== 'editing'} className="min-w-0">
            <legend className="sr-only">{stage.title}</legend>
            {stage.kind === 'self-assessment' ? (
              <DiagnosticTree
                topics={stage.topics}
                answers={state.answers}
                onAnswer={(id, value) => answer(id, { kind: 'self-report', value })}
              />
            ) : (
              currentQuestion && (
                <DiagnosticQuestionCard
                  isDarkMode={isDarkMode}
                  question={currentQuestion}
                  answer={state.answers[currentQuestion.id]}
                  onAnswer={next => answer(currentQuestion.id, next)}
                />
              )
            )}
          </fieldset>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4">
            {stage.kind === 'round' ? (
              <button
                type="button"
                className="diagnostic-secondary"
                aria-label={t('Precedente')}
                disabled={busy || position === 0}
                onClick={() =>
                  dispatch({
                    type: 'navigate',
                    position: position - 1,
                  })
                }
              >
                <ArrowLeft size={20} />
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="diagnostic-primary"
              aria-label={nextLabel}
              disabled={
                busy ||
                (status === 'stopped' &&
                  (stage.kind === 'self-assessment' || position === items.length - 1))
              }
              onClick={() => {
                if (stage.kind === 'self-assessment' || position === items.length - 1) {
                  void submit();
                  return;
                }
                dispatch({ type: 'navigate', position: position + 1 });
              }}
            >
              {busy && <Loader2 size={18} className="animate-spin" />}
              {stage.kind === 'self-assessment' || position === items.length - 1 ? nextLabel : null}
              <ArrowRight size={20} />
            </button>
          </div>
          {busy && <output className="sr-only">{t('Invio in corso...')}</output>}
          {status === 'failed' && (
            <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">
              {t('Invio non riuscito. Le risposte sono conservate. Riprova.')}
            </p>
          )}
          {status === 'stopped' && (
            <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">
              {t('La raccolta si è interrotta. Le risposte inviate sono conservate.')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
