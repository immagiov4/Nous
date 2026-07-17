import { Bug, Camera, CheckCircle2, Lightbulb, LoaderCircle, Send, Trash2, X } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type FeedbackDiagnosticsSnapshot,
  getFeedbackDiagnosticsSnapshot,
} from '../../services/feedback/browserDiagnostics.ts';
import { captureFeedbackScreenshot } from '../../services/feedback/captureScreenshot.ts';
import {
  type FeedbackCategory,
  type FeedbackScreenshot,
  type SubmittedFeedback,
  submitFeedback,
} from '../../services/feedback/feedbackApi.ts';
import {
  appendSpeechTranscription,
  default as SpeechInputButton,
} from '../shared/SpeechInputButton.tsx';

interface FeedbackDialogProps {
  onClose: () => void;
}

const MIN_DESCRIPTION_LENGTH = 10;
const FOCUSABLE_CONTROL_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FeedbackTitleProps {
  titleRef: RefObject<HTMLHeadingElement | null>;
}

function FeedbackSuccess({
  feedback,
  onClose,
  titleRef,
}: FeedbackTitleProps & { feedback: SubmittedFeedback; onClose: () => void }) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
        <CheckCircle2 className="h-7 w-7" />
      </span>
      <h2
        ref={titleRef}
        id="feedback-dialog-title"
        tabIndex={-1}
        className="mt-5 text-2xl font-serif text-stone-950 outline-none dark:text-zinc-100"
      >
        {t('Segnalazione inviata')}
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-stone-600 dark:text-zinc-300">
        {t('Grazie. La segnalazione è arrivata e può essere seguita dal team.')}
      </p>
      <p className="mt-2 text-xs text-stone-400 dark:text-zinc-500">
        {t('Riferimento: {feedbackId}', { feedbackId: feedback.id })}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-6 rounded-full bg-stone-950 px-5 py-2.5 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950"
      >
        {t('Chiudi')}
      </button>
    </div>
  );
}

function FeedbackHeader({ onClose, titleRef }: FeedbackTitleProps & { onClose: () => void }) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">
          {t('Feedback')}
        </p>
        <h2
          ref={titleRef}
          id="feedback-dialog-title"
          tabIndex={-1}
          className="mt-1 text-2xl font-serif text-stone-950 outline-none dark:text-zinc-100"
        >
          {t('Segnala un problema')}
        </h2>
        <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-zinc-300">
          {t('Raccontaci cosa è successo o cosa renderesti migliore.')}
        </p>
      </div>
      <button
        type="button"
        aria-label={t('Chiudi segnalazione')}
        onClick={onClose}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}

function FeedbackCategoryPicker({
  category,
  onChange,
}: {
  category: FeedbackCategory;
  onChange: (category: FeedbackCategory) => void;
}) {
  return (
    <fieldset className="mt-5 grid grid-cols-2 gap-2">
      <legend className="sr-only">{t('Tipo di segnalazione')}</legend>
      <button
        type="button"
        aria-pressed={category === 'bug'}
        onClick={() => onChange('bug')}
        className="flex items-center justify-center gap-2 rounded-2xl border border-stone-200 px-3 py-3 text-sm font-semibold text-stone-600 transition-colors aria-pressed:border-red-300 aria-pressed:bg-red-50 aria-pressed:text-red-700 dark:border-zinc-700 dark:text-zinc-300 dark:aria-pressed:border-red-700 dark:aria-pressed:bg-red-950/30 dark:aria-pressed:text-red-300"
      >
        <Bug className="h-4 w-4" />
        {t('Problema')}
      </button>
      <button
        type="button"
        aria-pressed={category === 'enhancement'}
        onClick={() => onChange('enhancement')}
        className="flex items-center justify-center gap-2 rounded-2xl border border-stone-200 px-3 py-3 text-sm font-semibold text-stone-600 transition-colors aria-pressed:border-amber-300 aria-pressed:bg-amber-50 aria-pressed:text-amber-800 dark:border-zinc-700 dark:text-zinc-300 dark:aria-pressed:border-amber-700 dark:aria-pressed:bg-amber-950/30 dark:aria-pressed:text-amber-200"
      >
        <Lightbulb className="h-4 w-4" />
        {t('Suggerimento')}
      </button>
    </fieldset>
  );
}

function FeedbackDescriptionField({
  description,
  isSubmitting,
  onChange,
  onTranscription,
}: {
  description: string;
  isSubmitting: boolean;
  onChange: (description: string) => void;
  onTranscription: (text: string) => void;
}) {
  return (
    <>
      <label
        htmlFor="feedback-description"
        className="mt-5 block text-sm font-semibold text-stone-800 dark:text-zinc-100"
      >
        {t('Descrizione')}
      </label>
      <div className="mt-2 rounded-2xl border border-stone-300 bg-white focus-within:border-stone-700 focus-within:ring-1 focus-within:ring-stone-700 dark:border-zinc-700 dark:bg-zinc-950 dark:focus-within:border-zinc-400 dark:focus-within:ring-zinc-400">
        <textarea
          id="feedback-description"
          required
          minLength={MIN_DESCRIPTION_LENGTH}
          rows={6}
          value={description}
          onChange={event => onChange(event.target.value)}
          placeholder={t('Cosa stavi facendo? Cosa ti aspettavi? Cosa è successo invece?')}
          className="w-full resize-y bg-transparent px-4 pt-3 text-sm leading-6 text-stone-950 outline-none placeholder:text-stone-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        <div className="flex items-center justify-between px-2 pb-2 pl-4">
          <span className="text-xs text-stone-400 dark:text-zinc-500">
            {t('Scrivi oppure usa il microfono')}
          </span>
          <SpeechInputButton
            variant="compact"
            disabled={isSubmitting}
            onTranscription={onTranscription}
          />
        </div>
      </div>
    </>
  );
}

function FeedbackDiagnostics({
  diagnostics,
  includeDiagnostics,
  onChange,
}: {
  diagnostics: FeedbackDiagnosticsSnapshot;
  includeDiagnostics: boolean;
  onChange: (checked: boolean) => void;
}) {
  const latestConsoleEntries = diagnostics.consoleEntries.slice(-5);

  return (
    <div className="mt-5 rounded-2xl border border-stone-200 bg-stone-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={includeDiagnostics}
          onChange={event => onChange(event.target.checked)}
          className="mt-1 h-4 w-4 rounded border-stone-300 text-orange-600 focus:ring-orange-500"
        />
        <span>
          <span className="block text-sm font-semibold text-stone-800 dark:text-zinc-100">
            {t('Allega diagnostica tecnica')}
          </span>
          <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-zinc-400">
            {t(
              'Include pagina e log recenti raccolti da Nous. Token, email e parametri degli URL vengono rimossi.'
            )}
          </span>
        </span>
      </label>
      {includeDiagnostics ? (
        <details className="mt-3 border-t border-stone-200 pt-3 text-xs text-stone-500 dark:border-zinc-700 dark:text-zinc-400">
          <summary className="cursor-pointer font-semibold text-stone-700 dark:text-zinc-200">
            {t('Anteprima diagnostica ({entryCount} log)', {
              entryCount: diagnostics.consoleEntries.length,
            })}
          </summary>
          <p className="mt-2 break-all">{diagnostics.pageUrl}</p>
          {latestConsoleEntries.length > 0 ? (
            <ul className="mt-2 space-y-1 font-mono">
              {latestConsoleEntries.map(entry => (
                <li key={`${entry.timestamp}-${entry.level}`} className="break-words">
                  [{entry.level}] {entry.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2">{t('Nessun log recente disponibile.')}</p>
          )}
        </details>
      ) : null}
    </div>
  );
}

function FeedbackScreenshotAttachment({
  isCapturing,
  onCapture,
  onRemove,
  screenshot,
  screenshotError,
}: {
  isCapturing: boolean;
  onCapture: () => void;
  onRemove: () => void;
  screenshot: FeedbackScreenshot | null;
  screenshotError: string;
}) {
  return (
    <div className="mt-3 rounded-2xl border border-stone-200 p-4 dark:border-zinc-700">
      {screenshot ? (
        <div className="flex items-center gap-3">
          <img
            src={screenshot.dataUrl}
            alt={t('Anteprima screenshot allegato')}
            className="h-16 w-28 rounded-lg border border-stone-200 object-cover dark:border-zinc-700"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-stone-800 dark:text-zinc-100">
              {t('Screenshot allegato')}
            </p>
            <p className="mt-1 text-xs text-stone-500 dark:text-zinc-400">
              {t('Controlla che non mostri informazioni che non vuoi condividere.')}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('Rimuovi screenshot')}
            onClick={onRemove}
            className="flex h-9 w-9 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-red-600 dark:hover:bg-zinc-800"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label={isCapturing ? t('Acquisizione in corso...') : t('Aggiungi uno screenshot')}
          disabled={isCapturing}
          onClick={onCapture}
          className="flex w-full items-center gap-3 text-left disabled:cursor-wait disabled:opacity-60"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-stone-100 text-stone-600 dark:bg-zinc-800 dark:text-zinc-300">
            {isCapturing ? (
              <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Camera className="h-4 w-4" />
            )}
          </span>
          <span>
            <span className="block text-sm font-semibold text-stone-800 dark:text-zinc-100">
              {isCapturing ? t('Acquisizione in corso...') : t('Aggiungi uno screenshot')}
            </span>
            <span className="mt-1 block text-xs text-stone-500 dark:text-zinc-400">
              {t('Facoltativo. Il browser ti chiederà quale pagina condividere.')}
            </span>
          </span>
        </button>
      )}
      {screenshotError ? (
        <p role="alert" className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
          {screenshotError}
        </p>
      ) : null}
    </div>
  );
}

function FeedbackSubmitFooter({
  canSubmit,
  isCapturing,
  isSubmitting,
  onClose,
  onSubmit,
}: {
  canSubmit: boolean;
  isCapturing: boolean;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <footer className="mt-5 flex items-center justify-end gap-2 border-t border-stone-200 pt-4 dark:border-zinc-700">
      <button
        type="button"
        disabled={isSubmitting || isCapturing}
        onClick={onClose}
        className="rounded-full px-4 py-2.5 text-sm font-semibold text-stone-600 disabled:opacity-50 dark:text-zinc-300"
      >
        {t('Annulla')}
      </button>
      <button
        type="button"
        disabled={!canSubmit}
        aria-busy={isSubmitting}
        onClick={onSubmit}
        className="inline-flex items-center gap-2 rounded-full bg-stone-950 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950"
      >
        {isSubmitting ? (
          <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Send className="h-4 w-4" />
        )}
        {isSubmitting ? t('Invio in corso...') : t('Invia segnalazione')}
      </button>
    </footer>
  );
}

interface FeedbackFormProps extends FeedbackTitleProps {
  category: FeedbackCategory;
  description: string;
  diagnostics: FeedbackDiagnosticsSnapshot;
  errorMessage: string;
  includeDiagnostics: boolean;
  isCapturing: boolean;
  isSubmitting: boolean;
  onCategoryChange: (category: FeedbackCategory) => void;
  onClose: () => void;
  onDescriptionChange: (description: string) => void;
  onDiagnosticsChange: (checked: boolean) => void;
  onScreenshotCapture: () => void;
  onScreenshotRemove: () => void;
  onSubmit: () => void;
  onTranscription: (text: string) => void;
  screenshot: FeedbackScreenshot | null;
  screenshotError: string;
}

function FeedbackForm(props: FeedbackFormProps) {
  const canSubmit =
    !props.isSubmitting &&
    !props.isCapturing &&
    props.description.trim().length >= MIN_DESCRIPTION_LENGTH;

  return (
    <>
      <FeedbackHeader onClose={props.onClose} titleRef={props.titleRef} />
      <FeedbackCategoryPicker category={props.category} onChange={props.onCategoryChange} />
      <FeedbackDescriptionField
        description={props.description}
        isSubmitting={props.isSubmitting}
        onChange={props.onDescriptionChange}
        onTranscription={props.onTranscription}
      />
      {props.category === 'bug' ? (
        <>
          <FeedbackDiagnostics
            diagnostics={props.diagnostics}
            includeDiagnostics={props.includeDiagnostics}
            onChange={props.onDiagnosticsChange}
          />
          <FeedbackScreenshotAttachment
            isCapturing={props.isCapturing}
            onCapture={props.onScreenshotCapture}
            onRemove={props.onScreenshotRemove}
            screenshot={props.screenshot}
            screenshotError={props.screenshotError}
          />
        </>
      ) : null}
      {props.errorMessage ? (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200"
        >
          {props.errorMessage}
        </p>
      ) : null}
      <FeedbackSubmitFooter
        canSubmit={canSubmit}
        isCapturing={props.isCapturing}
        isSubmitting={props.isSubmitting}
        onClose={props.onClose}
        onSubmit={props.onSubmit}
      />
    </>
  );
}

export default function FeedbackDialog({ onClose }: FeedbackDialogProps) {
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [description, setDescription] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<FeedbackDiagnosticsSnapshot>(() =>
    getFeedbackDiagnosticsSnapshot()
  );
  const [screenshot, setScreenshot] = useState<FeedbackScreenshot | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [screenshotError, setScreenshotError] = useState('');
  const [submittedFeedback, setSubmittedFeedback] = useState<SubmittedFeedback | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => titleRef.current?.focus(), []);

  const closeDialog = useCallback(() => {
    if (!isSubmitting && !isCapturing) onClose();
  }, [isCapturing, isSubmitting, onClose]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== 'Tab') return;

      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_CONTROL_SELECTOR) || []
      );
      if (controls.length === 0) return;

      const activeIndex = controls.indexOf(document.activeElement as HTMLElement);
      const shouldWrapBackward = event.shiftKey && activeIndex <= 0;
      const shouldWrapForward = !event.shiftKey && activeIndex === controls.length - 1;
      const shouldEnterForward = !event.shiftKey && activeIndex === -1;
      if (!shouldWrapBackward && !shouldWrapForward && !shouldEnterForward) return;

      event.preventDefault();
      (shouldWrapBackward ? controls.at(-1) : controls[0])?.focus();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeDialog]);

  const handleDiagnosticsChange = (checked: boolean) => {
    setIncludeDiagnostics(checked);
    if (checked) setDiagnostics(getFeedbackDiagnosticsSnapshot());
  };

  const handleCategoryChange = (nextCategory: FeedbackCategory) => {
    setCategory(nextCategory);
    if (nextCategory === 'enhancement') {
      setIncludeDiagnostics(false);
      setScreenshot(null);
      setScreenshotError('');
    }
  };

  const handleScreenshotCapture = async () => {
    setIsCapturing(true);
    setScreenshotError('');
    layerRef.current?.classList.add('invisible');
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      setScreenshot(await captureFeedbackScreenshot());
    } catch {
      setScreenshotError(
        t('Screenshot non acquisito. Puoi comunque inviare la segnalazione senza allegato.')
      );
    } finally {
      layerRef.current?.classList.remove('invisible');
      setIsCapturing(false);
    }
  };

  const handleSubmit = async () => {
    const trimmedDescription = description.trim();
    if (trimmedDescription.length < MIN_DESCRIPTION_LENGTH) return;
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const feedback = await submitFeedback({
        category,
        description: trimmedDescription,
        diagnostics: category === 'bug' && includeDiagnostics ? diagnostics : undefined,
        screenshot: category === 'bug' ? screenshot || undefined : undefined,
      });
      setSubmittedFeedback(feedback);
    } catch {
      setErrorMessage(t('Invio non riuscito. Controlla la connessione e riprova.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const content = submittedFeedback ? (
    <FeedbackSuccess feedback={submittedFeedback} onClose={onClose} titleRef={titleRef} />
  ) : (
    <FeedbackForm
      category={category}
      description={description}
      diagnostics={diagnostics}
      errorMessage={errorMessage}
      includeDiagnostics={includeDiagnostics}
      isCapturing={isCapturing}
      isSubmitting={isSubmitting}
      onCategoryChange={handleCategoryChange}
      onClose={closeDialog}
      onDescriptionChange={setDescription}
      onDiagnosticsChange={handleDiagnosticsChange}
      onScreenshotCapture={() => void handleScreenshotCapture()}
      onScreenshotRemove={() => setScreenshot(null)}
      onSubmit={() => void handleSubmit()}
      onTranscription={text => setDescription(current => appendSpeechTranscription(current, text))}
      screenshot={screenshot}
      screenshotError={screenshotError}
      titleRef={titleRef}
    />
  );

  return createPortal(
    <div
      ref={layerRef}
      className="fixed inset-0 z-[170] flex items-end p-3 sm:items-center sm:justify-center"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('Chiudi segnalazione')}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={closeDialog}
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
        className="relative max-h-[calc(100vh-1.5rem)] w-full max-w-xl overflow-y-auto rounded-[1.8rem] border border-stone-200 bg-white p-5 shadow-2xl sm:p-6 dark:border-zinc-700 dark:bg-zinc-900"
      >
        {content}
      </section>
    </div>,
    document.body
  );
}
