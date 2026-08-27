import { LoaderCircle, Mic, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getAppLocale, translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  requestSpeechTranscription,
  type SttAudioFormat,
} from '../../services/openrouter/sttClient.ts';

const MAX_SPEECH_RECORDING_MS = 90_000;
const TEMPORARY_ERROR_DISMISS_MS = 8_000;
const VIEWPORT_ERROR_ALERT_BOTTOM =
  'calc(max(1rem, env(safe-area-inset-bottom, 0px)) + var(--keyboard-inset, 0px))';

const RECORDING_FORMATS: ReadonlyArray<{
  format: SttAudioFormat;
  mimeType: string;
}> = [
  { mimeType: 'audio/webm;codecs=opus', format: 'webm' },
  { mimeType: 'audio/webm', format: 'webm' },
  { mimeType: 'audio/ogg;codecs=opus', format: 'ogg' },
  { mimeType: 'audio/mp4', format: 'm4a' },
];

type SpeechInputState = 'idle' | 'recording' | 'transcribing';
type SpeechInputVariant = 'compact' | 'round';

interface SpeechInputError {
  autoDismiss: boolean;
  message: string;
  retryAvailable?: boolean;
}

interface FailedTranscription {
  audio: Blob;
  format: SttAudioFormat;
}

interface SpeechInputButtonProps {
  readonly disabled?: boolean;
  readonly errorPresentation?: 'inline' | 'viewport';
  readonly language?: string;
  readonly onTranscription: (text: string) => void;
  readonly variant?: SpeechInputVariant;
}

const stopStreamTracks = (stream: MediaStream | null) => {
  stream?.getTracks().forEach(track => {
    track.stop();
  });
};

const getMicrophoneError = (error: unknown): SpeechInputError => {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return {
      autoDismiss: false,
      message: t('Permesso microfono negato. Abilitalo nelle impostazioni del browser.'),
    };
  }

  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return { autoDismiss: false, message: t('Nessun microfono disponibile.') };
  }

  if (error instanceof DOMException && error.name === 'NotReadableError') {
    return {
      autoDismiss: true,
      message: t('Il microfono è occupato o non è temporaneamente disponibile. Riprova.'),
    };
  }

  return {
    autoDismiss: true,
    message: t('Non riesco ad accedere al microfono. Riprova.'),
  };
};

const selectRecordingFormat = () => {
  const selectedFormat = RECORDING_FORMATS.find(({ mimeType }) =>
    MediaRecorder.isTypeSupported(mimeType)
  );

  return selectedFormat || RECORDING_FORMATS[0];
};

const getButtonLabel = (state: SpeechInputState): string => {
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

export default function SpeechInputButton({
  disabled = false,
  errorPresentation = 'inline',
  language = getAppLocale(),
  onTranscription,
  variant = 'round',
}: SpeechInputButtonProps) {
  const [state, setState] = useState<SpeechInputState>('idle');
  const [speechInputError, setSpeechInputError] = useState<SpeechInputError | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedTranscriptionRef = useRef<FailedTranscription | null>(null);
  const isMountedRef = useRef(true);
  const onTranscriptionRef = useRef(onTranscription);

  useEffect(() => {
    onTranscriptionRef.current = onTranscription;
  }, [onTranscription]);

  useEffect(() => {
    if (!speechInputError?.autoDismiss) {
      return;
    }

    const timeout = globalThis.window.setTimeout(() => {
      setSpeechInputError(null);
    }, TEMPORARY_ERROR_DISMISS_MS);

    return () => {
      globalThis.window.clearTimeout(timeout);
    };
  }, [speechInputError]);

  const clearRecordingTimeout = useCallback(() => {
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    clearRecordingTimeout();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, [clearRecordingTimeout]);

  const transcribeRecording = useCallback(
    async ({ audio, format }: FailedTranscription) => {
      setState('transcribing');
      setSpeechInputError(null);

      try {
        const transcription = await requestSpeechTranscription(audio, format, language);
        if (isMountedRef.current) {
          failedTranscriptionRef.current = null;
          onTranscriptionRef.current(transcription);
        }
      } catch {
        if (isMountedRef.current) {
          failedTranscriptionRef.current = { audio, format };
          setSpeechInputError({
            autoDismiss: false,
            message: t('Trascrizione non riuscita. Puoi riprovare senza registrare di nuovo.'),
            retryAvailable: true,
          });
        }
      } finally {
        if (isMountedRef.current) {
          setState('idle');
        }
      }
    },
    [language]
  );

  const startRecording = useCallback(async () => {
    setSpeechInputError(null);
    failedTranscriptionRef.current = null;

    if (globalThis.window.isSecureContext === false) {
      setSpeechInputError({
        autoDismiss: false,
        message: t('Il microfono richiede una connessione sicura (HTTPS o localhost).'),
      });
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setSpeechInputError({
        autoDismiss: false,
        message: t('La registrazione audio non è supportata da questo browser.'),
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isMountedRef.current) {
        stopStreamTracks(stream);
        return;
      }

      const recordingFormat = selectRecordingFormat();
      const recorder = new MediaRecorder(stream, { mimeType: recordingFormat.mimeType });
      const audioChunks: Blob[] = [];

      recorderRef.current = recorder;
      streamRef.current = stream;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };
      recorder.onerror = () => {
        recorder.onstop = null;
        clearRecordingTimeout();
        stopStreamTracks(stream);
        recorderRef.current = null;
        streamRef.current = null;
        if (isMountedRef.current) {
          setState('idle');
          setSpeechInputError({
            autoDismiss: true,
            message: t('La registrazione si è interrotta. Riprova.'),
          });
        }
      };
      recorder.onstop = async () => {
        clearRecordingTimeout();
        stopStreamTracks(stream);
        recorderRef.current = null;
        streamRef.current = null;
        if (!isMountedRef.current) {
          return;
        }

        const audio = new Blob(audioChunks, { type: recorder.mimeType });
        if (audio.size === 0) {
          setState('idle');
          setSpeechInputError({
            autoDismiss: true,
            message: t('Non ho rilevato audio. Riprova.'),
          });
          return;
        }

        await transcribeRecording({ audio, format: recordingFormat.format });
      };

      recorder.start();
      setState('recording');
      recordingTimeoutRef.current = setTimeout(() => {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      }, MAX_SPEECH_RECORDING_MS);
    } catch (error) {
      stopStreamTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      setState('idle');
      setSpeechInputError(getMicrophoneError(error));
    }
  }, [clearRecordingTimeout, transcribeRecording]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      clearRecordingTimeout();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
      }
      stopStreamTracks(streamRef.current);
    };
  }, [clearRecordingTimeout]);

  const isRecording = state === 'recording';
  const isTranscribing = state === 'transcribing';
  const buttonLabel = getButtonLabel(state);
  const isButtonDisabled = isTranscribing || (disabled && !isRecording);
  const sizeClassName = variant === 'compact' ? 'h-8 w-8 rounded-xl' : 'h-10 w-10 rounded-full';
  const colorClassName = isRecording
    ? 'bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-500/20 dark:text-red-300 dark:hover:bg-red-500/30'
    : 'text-stone-400 hover:bg-stone-100 hover:text-stone-600 disabled:text-stone-300 dark:text-stone-500 dark:hover:bg-zinc-700 dark:hover:text-stone-300 dark:disabled:text-stone-600';
  const speechErrorAlert = speechInputError ? (
    <div
      role="alert"
      aria-label={speechInputError.message}
      data-nous-context-menu-portal={errorPresentation === 'viewport' || undefined}
      style={errorPresentation === 'viewport' ? { bottom: VIEWPORT_ERROR_ALERT_BOTTOM } : undefined}
      className={`${
        errorPresentation === 'viewport'
          ? 'fixed inset-x-4 z-[70] w-auto'
          : 'absolute bottom-[calc(100%+0.6rem)] right-0 z-30 w-64'
      } flex items-start gap-2 rounded-xl border border-red-200 bg-white px-3 py-2 text-xs leading-5 text-red-700 shadow-lg dark:border-red-900/70 dark:bg-stone-800 dark:text-red-200`}
    >
      <span className="min-w-0 flex-1">
        {speechInputError.message}
        {speechInputError.retryAvailable ? (
          <button
            type="button"
            onClick={() => {
              const failedTranscription = failedTranscriptionRef.current;
              if (failedTranscription) {
                void transcribeRecording(failedTranscription);
              }
            }}
            className="mt-1 block font-semibold underline underline-offset-2 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:text-white"
          >
            {t('Riprova trascrizione')}
          </button>
        ) : null}
      </span>
      <button
        type="button"
        onClick={() => setSpeechInputError(null)}
        aria-label={t('Chiudi avviso microfono')}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-100 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-300 dark:hover:bg-red-950/60 dark:hover:text-red-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
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
