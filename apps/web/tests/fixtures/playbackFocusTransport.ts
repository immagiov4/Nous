import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { useCallback, useState } from 'react';

// Only narration transport is synthetic; the player, recorder and overlays are real.
export function useLessonPlayback() {
  const [playing, setPlaying] = useState(true);
  const pause = useCallback(() => setPlaying(false), []);
  const play = useCallback(async () => setPlaying(true), []);
  return {
    lessonKey: 'focus-fixture',
    blocks: segmentLessonPlayback([{ type: 'markdown', markdown: 'Una lezione di prova.' }]),
    index: 0,
    time: 0,
    elapsed: 0,
    duration: 12,
    total: 12,
    playing,
    loading: false,
    estimated: false,
    failed: false,
    seekRevision: 0,
    pause,
    play,
    seek: () => {},
    readTime: () => 0,
    readPosition: () => ({ index: 0, time: 0, duration: 12 }),
  };
}
