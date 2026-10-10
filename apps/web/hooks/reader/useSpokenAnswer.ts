import { useCallback, useEffect, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { generateSpeech } from '../../services/openrouter/tts.ts';
import { splitContentIntoChunks } from './useTtsPlayer.ts';

type Speech = Awaited<ReturnType<typeof generateSpeech>>;

interface SpokenRun {
  readonly controller: AbortController;
  /** Sentences of the current answer already sent to speech. */
  spoken: number;
  /** Speech requests run ahead of playback, at most SPEECH_REQUEST_SLOTS at a time. */
  slots: Promise<unknown>[];
  /** Clips queued so far, which picks the slot of the next one. */
  queued: number;
  playback: Promise<void>;
}

const SPEECH_REQUEST_SLOTS = 2;

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const splitSentences = (text: string) =>
  Array.from(sentenceSegmenter.segment(text), part => part.segment).filter(part => part.trim());

const playSpeech = async (speech: Speech, speed: number, signal: AbortSignal) => {
  const url = URL.createObjectURL(new Blob([speech.audioBuffer], { type: speech.contentType }));
  const audio = new Audio(url);
  audio.playbackRate = speed;
  let finish = () => {};
  const cancel = () => {
    audio.pause();
    finish();
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('Answer audio playback failed'));
      void audio.play().then(() => {
        if (signal.aborted) audio.pause();
      }, reject);
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  }
};

/**
 * Reads an answer aloud while it streams: each completed sentence goes to the reader's speech
 * service as soon as it arrives, and plays in order once the previous one has ended.
 */
export function useSpokenAnswer(voice: string, speed: number) {
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const run = useRef<SpokenRun | null>(null);
  const stop = useCallback(() => {
    run.current?.controller.abort();
    run.current = null;
    setSpeaking(false);
  }, []);
  useEffect(() => stop, [stop]);

  const follow = useCallback(
    (text: string, complete: boolean) => {
      if (!run.current) {
        setError(null);
        run.current = {
          controller: new AbortController(),
          spoken: 0,
          slots: Array.from({ length: SPEECH_REQUEST_SLOTS }, () => Promise.resolve()),
          queued: 0,
          playback: Promise.resolve(),
        };
      }
      const current = run.current;
      const { signal } = current.controller;
      const fail = (failure: unknown) => {
        if (signal.aborted) return;
        console.error('Spoken answer failed', failure);
        current.controller.abort();
        if (run.current === current) run.current = null;
        setSpeaking(false);
        setError(t('Non è stato possibile leggere la risposta. Puoi leggerla nel pannello.'));
      };
      const sentences = splitSentences(text);
      // The last sentence may still be growing until the answer is complete.
      const ready = complete ? sentences : sentences.slice(0, -1);
      for (const sentence of ready.slice(current.spoken)) {
        setSpeaking(true);
        for (const chunk of splitContentIntoChunks(sentence, [])) {
          // Each clip waits for the request two places before it, so two run in parallel.
          const slot = current.queued++ % SPEECH_REQUEST_SLOTS;
          const speech = current.slots[slot].then(() =>
            signal.aborted ? null : generateSpeech(chunk, voice)
          );
          current.slots[slot] = speech.catch(() => undefined);
          current.playback = current.playback
            .then(async () => {
              const clip = await speech;
              if (clip && !signal.aborted) await playSpeech(clip, speed, signal);
            })
            .catch(fail);
        }
      }
      if (!complete) {
        current.spoken = Math.max(current.spoken, ready.length);
        return;
      }
      // A completed answer resets the count, so a follow-up answer queues after this one.
      current.spoken = 0;
      const tail = current.playback;
      void tail.then(() => {
        if (run.current === current && current.playback === tail) setSpeaking(false);
      });
    },
    [speed, voice]
  );

  return { follow, stop, speaking, error, clearError: () => setError(null) };
}
