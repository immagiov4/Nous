import { LoaderCircle, Mic, Square, X } from 'lucide-react';
import { createPortal } from 'react-dom';

import { type SpeechInputController, useSpeechInput } from '../../hooks/useSpeechInput.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';

const VIEWPORT_ERROR_ALERT_BOTTOM =
  'calc(max(1rem, env(safe-area-inset-bottom, 0px)) + var(--keyboard-inset, 0px))';

interface SpeechInputButtonProps {
  readonly controller?: SpeechInputController;
  readonly disabled?: boolean;
  readonly errorPresentation?: 'inline' | 'viewport';
  readonly language?: string;
  readonly onTranscription: (text: string) => void;
  readonly variant?: 'compact' | 'round';
}

const getButtonLabel = (state: SpeechInputController['state']): string => {
  if (state === 'recording') {
    return t('Ferma e trascrivi');
  }

  if (state === 'transcribing') {
    return t('Trascrizione in corso');
  }

  return t('Avvia dettatura');
};

export const appendSpeechTranscription = (currentValue: string, transcription: string): string => {
  const currentText = currentValue.trimEnd();
  const transcribedText = transcription.trim();

  return currentText ? `${currentText} ${transcribedText}` : transcribedText;
};

function SpeechErrorAlert({
  error,
  onDismiss,
  onRetry,
  presentation,
}: Readonly<{
  error: NonNullable<SpeechInputController['speechInputError']>;
  onDismiss: () => void;
  onRetry: () => void;
  presentation: 'inline' | 'viewport';
}>) {
  const isViewportAlert = presentation === 'viewport';
  return (
    <div
      role="alert"
      aria-label={error.message}
      data-nous-context-menu-portal={isViewportAlert || undefined}
      style={isViewportAlert ? { bottom: VIEWPORT_ERROR_ALERT_BOTTOM } : undefined}
      className={`${
        isViewportAlert
          ? 'fixed inset-x-4 z-[70] w-auto'
          : 'absolute bottom-[calc(100%+0.6rem)] right-0 z-30 w-64'
      } flex items-start gap-2 rounded-xl border border-red-200 bg-white px-3 py-2 text-xs leading-5 text-red-700 shadow-lg dark:border-red-900/70 dark:bg-stone-800 dark:text-red-200`}
    >
      <span className="min-w-0 flex-1">
        {error.message}
        {error.retryAvailable ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 block font-semibold underline underline-offset-2 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:text-white"
          >
            {t('Riprova trascrizione')}
          </button>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('Chiudi avviso microfono')}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-100 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-300 dark:hover:bg-red-950/60 dark:hover:text-red-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function SpeechInputButton(props: SpeechInputButtonProps) {
  if (props.controller) return <SpeechInputButtonView {...props} controller={props.controller} />;
  return <LocalSpeechInputButton {...props} />;
}

function LocalSpeechInputButton(props: SpeechInputButtonProps) {
  const controller = useSpeechInput(props);
  return <SpeechInputButtonView {...props} controller={controller} />;
}

function SpeechInputButtonView({
  disabled = false,
  errorPresentation = 'inline',
  variant = 'round',
  controller,
}: SpeechInputButtonProps & { controller: SpeechInputController }) {
  const {
    state,
    speechInputError,
    startRecording,
    stopRecording,
    retryFailedTranscription,
    dismissError,
  } = controller;
  const isRecording = state === 'recording';
  const isTranscribing = state === 'transcribing';
  const buttonLabel = getButtonLabel(state);
  const isButtonDisabled = state === 'requesting' || isTranscribing || (disabled && !isRecording);
  const sizeClassName = variant === 'compact' ? 'h-8 w-8 rounded-xl' : 'h-10 w-10 rounded-full';
  const colorClassName = isRecording
    ? 'bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-500/20 dark:text-red-300 dark:hover:bg-red-500/30'
    : 'text-stone-400 hover:bg-stone-100 hover:text-stone-600 disabled:text-stone-300 dark:text-stone-500 dark:hover:bg-zinc-700 dark:hover:text-stone-300 dark:disabled:text-stone-600';
  const speechErrorAlert = speechInputError ? (
    <SpeechErrorAlert
      error={speechInputError}
      onDismiss={dismissError}
      onRetry={retryFailedTranscription}
      presentation={errorPresentation}
    />
  ) : null;

  return (
    <div className="relative flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => {
          if (isRecording) {
            stopRecording();
            return;
          }

          if (!isTranscribing) {
            void startRecording();
          }
        }}
        disabled={isButtonDisabled}
        aria-label={buttonLabel}
        aria-pressed={isRecording}
        title={buttonLabel}
        className={`flex shrink-0 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed ${sizeClassName} ${colorClassName}`}
      >
        {isTranscribing ? (
          <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : isRecording ? (
          <Square className="h-3.5 w-3.5 fill-current" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </button>

      <span className="sr-only" aria-live="polite">
        {isRecording ? t('Registrazione in corso.') : null}
        {isTranscribing ? t('Sto trascrivendo la registrazione.') : null}
      </span>

      {errorPresentation === 'viewport' && speechErrorAlert
        ? createPortal(speechErrorAlert, document.body)
        : speechErrorAlert}
    </div>
  );
}
