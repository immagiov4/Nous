import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { useCallback, useState } from 'react';

const DURATION_SECONDS = 12;

// Only narration transport is synthetic; the player, recorder and overlays are real.
export function useLessonPlayback() {
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const pause = useCallback(() => setPlaying(false), []);
  const play = useCallback(async () => setPlaying(true), []);
  return {
    lessonKey: 'focus-fixture',
    blocks: segmentLessonPlayback([{ type: 'markdown', markdown: 'Una lezione di prova.' }]),
    index: 0,
    time,
    elapsed: time,
    duration: DURATION_SECONDS,
    total: DURATION_SECONDS,
    playing,
    loading: false,
    estimated: false,
    failed: false,
    seekRevision: 0,
    pause,
    play,
    seek: (target: number) => setTime(Math.max(0, Math.min(DURATION_SECONDS, target))),
    readTime: () => time,
    readPosition: () => ({ index: 0, time, duration: DURATION_SECONDS }),
  };
}
