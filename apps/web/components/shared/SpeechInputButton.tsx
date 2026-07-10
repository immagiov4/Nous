import { LoaderCircle, Mic, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getAppLocale, translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  requestSpeechTranscription,
  type SttAudioFormat,
} from '../../services/openrouter/sttClient.ts';

const MAX_SPEECH_RECORDING_MS = 90_000;

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

interface SpeechInputButtonProps {
  disabled?: boolean;
  language?: string;
  onTranscription: (text: string) => void;
  variant?: SpeechInputVariant;
}

const stopStreamTracks = (stream: MediaStream | null) => {
  stream?.getTracks().forEach(track => {
    track.stop();
  });
};

const getMicrophoneErrorMessage = (error: unknown): string => {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return t('Permesso microfono negato. Abilitalo nelle impostazioni del browser.');
  }

  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return t('Nessun microfono disponibile.');
  }

  return t('Non riesco ad accedere al microfono. Riprova.');
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
  language = getAppLocale(),
  onTranscription,
  variant = 'round',
}: SpeechInputButtonProps) {
  const [state, setState] = useState<SpeechInputState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const onTranscriptionRef = useRef(onTranscription);

  useEffect(() => {
    onTranscriptionRef.current = onTranscription;
  }, [onTranscription]);

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

  const startRecording = useCallback(async () => {
    setErrorMessage(null);

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setErrorMessage(t('La registrazione audio non è supportata da questo browser.'));
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
          setErrorMessage(t('La registrazione si è interrotta. Riprova.'));
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
          setErrorMessage(t('Non ho rilevato audio. Riprova.'));
          return;
        }

        setState('transcribing');
        try {
          const transcription = await requestSpeechTranscription(
            audio,
            recordingFormat.format,
            language
          );
          if (isMountedRef.current) {
            onTranscriptionRef.current(transcription);
          }
        } catch {
          if (isMountedRef.current) {
            setErrorMessage(t('Trascrizione non riuscita. Riprova.'));
          }
        } finally {
          if (isMountedRef.current) {
            setState('idle');
          }
        }
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
      setErrorMessage(getMicrophoneErrorMessage(error));
    }
  }, [clearRecordingTimeout, language]);

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

      {errorMessage ? (
        <div
          role="alert"
          aria-label={errorMessage}
          className="absolute bottom-[calc(100%+0.6rem)] right-0 z-30 w-64 rounded-xl border border-red-200 bg-white px-3 py-2 text-xs leading-5 text-red-700 shadow-lg dark:border-red-900/70 dark:bg-stone-800 dark:text-red-200"
        >
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
