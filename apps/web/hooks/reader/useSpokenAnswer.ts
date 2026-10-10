import { useCallback, useEffect, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { generateSpeech } from '../../services/openrouter/tts.ts';
import { splitContentIntoChunks } from './useTtsPlayer.ts';

/** Reads the complete answer through the reader's speech service and text preparation. */
export function useSpokenAnswer(voice: string, speed: number) {
  const [error, setError] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);
  const stop = useCallback(() => {
    run.current?.abort();
    run.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const speak = useCallback(
    async (text: string) => {
      stop();
      setError(null);
      const controller = new AbortController();
      run.current = controller;
      try {
        for (const chunk of splitContentIntoChunks(text, [])) {
          const speech = await generateSpeech(chunk, voice);
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(
            new Blob([speech.audioBuffer], { type: speech.contentType })
          );
          const audio = new Audio(url);
          audio.playbackRate = speed;
          let finish = () => {};
          const cancel = () => {
            audio.pause();
            finish();
          };
          controller.signal.addEventListener('abort', cancel, { once: true });
          try {
            await new Promise<void>((resolve, reject) => {
              finish = resolve;
              audio.onended = () => resolve();
              audio.onerror = () => reject(new Error('Answer audio playback failed'));
              void audio.play().then(() => {
                if (controller.signal.aborted) audio.pause();
              }, reject);
            });
          } finally {
            controller.signal.removeEventListener('abort', cancel);
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            URL.revokeObjectURL(url);
          }
          if (controller.signal.aborted) return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Spoken answer failed', error);
        setError(t('Non è stato possibile leggere la risposta. Puoi leggerla nel pannello.'));
      }
    },
    [speed, stop, voice]
  );

  return { speak, stop, error, clearError: () => setError(null) };
}
