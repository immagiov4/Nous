import { useCallback, useEffect, useRef, useState } from 'react';
import { getAppLocale, translateUiMessage as t } from '../i18n/uiMessages.ts';
import {
  requestSpeechTranscription,
  type SttAudioFormat,
} from '../services/openrouter/sttClient.ts';

const MAX_SPEECH_RECORDING_MS = 90_000;
const TEMPORARY_ERROR_DISMISS_MS = 8_000;

const RECORDING_FORMATS: ReadonlyArray<{
  format: SttAudioFormat;
  mimeType: string;
}> = [
  { mimeType: 'audio/webm;codecs=opus', format: 'webm' },
  { mimeType: 'audio/webm', format: 'webm' },
  { mimeType: 'audio/ogg;codecs=opus', format: 'ogg' },
  { mimeType: 'audio/mp4', format: 'm4a' },
];

type SpeechInputState = 'idle' | 'requesting' | 'recording' | 'transcribing';

interface SpeechInputError {
  autoDismiss: boolean;
  message: string;
  retryAvailable?: boolean;
}

interface FailedTranscription {
  audio: Blob;
  format: SttAudioFormat;
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

export function useSpeechInput({
  onTranscription,
  language = getAppLocale(),
}: {
  onTranscription: (text: string) => void;
  language?: string;
}) {
  const [state, setState] = useState<SpeechInputState>('idle');
  const [speechInputError, setSpeechInputError] = useState<SpeechInputError | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedTranscriptionRef = useRef<FailedTranscription | null>(null);
  const isMountedRef = useRef(true);
  const onTranscriptionRef = useRef(onTranscription);
  const session = useRef(0);
  const starting = useRef(false);
  const stopRequested = useRef(false);

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
    stopRequested.current = true;
    clearRecordingTimeout();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, [clearRecordingTimeout]);

  const transcribeRecording = useCallback(
    async ({ audio, format }: FailedTranscription) => {
      const recordingSession = session.current;
      setState('transcribing');
      setSpeechInputError(null);

      try {
        const transcription = await requestSpeechTranscription(audio, format, language);
        if (isMountedRef.current && recordingSession === session.current) {
          failedTranscriptionRef.current = null;
          onTranscriptionRef.current(transcription);
        }
      } catch {
        if (isMountedRef.current && recordingSession === session.current) {
          failedTranscriptionRef.current = { audio, format };
          setSpeechInputError({
            autoDismiss: false,
            message: t('Trascrizione non riuscita. Puoi riprovare senza registrare di nuovo.'),
            retryAvailable: true,
          });
        }
      } finally {
        if (isMountedRef.current && recordingSession === session.current) {
          setState('idle');
        }
      }
    },
    [language]
  );

  const startRecording = useCallback(async () => {
    if (starting.current || recorderRef.current) return;
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

    const recordingSession = ++session.current;
    starting.current = true;
    stopRequested.current = false;
    setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isMountedRef.current || recordingSession !== session.current) {
        stopStreamTracks(stream);
        return;
      }

      if (stopRequested.current) {
        stopStreamTracks(stream);
        setState('idle');
        setSpeechInputError({ autoDismiss: true, message: t('Non ho rilevato audio. Riprova.') });
        return;
      }
      streamRef.current = stream;
      const recordingFormat = selectRecordingFormat();
      const recorder = new MediaRecorder(stream, { mimeType: recordingFormat.mimeType });
      const audioChunks: Blob[] = [];

      recorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };
      recorder.onerror = () => {
        if (recordingSession !== session.current) return;
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
        if (recordingSession !== session.current) return;
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
      if (!isMountedRef.current || recordingSession !== session.current) return;
      stopStreamTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      setState('idle');
      setSpeechInputError(getMicrophoneError(error));
    } finally {
      if (recordingSession === session.current) starting.current = false;
    }
  }, [clearRecordingTimeout, transcribeRecording]);

  const cancel = useCallback(() => {
    session.current++;
    starting.current = false;
    clearRecordingTimeout();
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    stopStreamTracks(streamRef.current);
    streamRef.current = null;
    recorderRef.current = null;
    failedTranscriptionRef.current = null;
  }, [clearRecordingTimeout]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancel();
    };
  }, [cancel]);

  const reset = () => {
    cancel();
    setState('idle');
    setSpeechInputError(null);
  };
  const retryFailedTranscription = () => {
    const failed = failedTranscriptionRef.current;
    if (failed) void transcribeRecording(failed);
  };
  return {
    state,
    speechInputError,
    startRecording,
    stopRecording,
    reset,
    retryFailedTranscription,
    dismissError: () => setSpeechInputError(null),
  };
}

export type SpeechInputController = ReturnType<typeof useSpeechInput>;
