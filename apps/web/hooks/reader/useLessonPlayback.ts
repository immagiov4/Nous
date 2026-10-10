import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getLessonPlayback,
  LessonPlaybackRequestError,
  prepareLessonPlayback,
  waitForLessonPlayback,
} from '../../services/openrouter/lessonPlaybackClient.ts';
import { downloadProjectAssetBytes } from '../../services/projects/projectAssetClient.ts';

import { playbackTimeline } from '../../utils/reader/lessonPlayback.ts';

type Playback = Awaited<ReturnType<typeof getLessonPlayback>>;

/** Owns one audio element and a serial preparation queue for the current lesson. */
export function useLessonPlayback({
  projectId,
  sectionId,
  voice,
  speed,
  initialBlocks,
}: {
  projectId: string;
  sectionId: string;
  voice: string;
  speed: number;
  initialBlocks: LessonPlaybackBlock[];
}) {
  const [blocks, setBlocks] = useState<readonly LessonPlaybackBlock[]>(initialBlocks);
  const [index, setIndex] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const getAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) throw new Error('Playback audio must be mounted');
    return audio;
  }, []);
  const playbackRef = useRef<Playback | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const lifetime = useRef<AbortController | null>(null);
  const intent = useRef({ playing: false, index: 0, epoch: 0 });
  const objectUrl = useRef<string | null>(null);
  const ready = useRef(new Map<string, LessonPlaybackBlock>());
  const started = useRef(false);
  const previousVoice = useRef(voice);
  const loadedVoice = useRef<string | null>(null);
  const latest = useRef({ voice, speed });
  useEffect(() => {
    latest.current = { voice, speed };
  }, [voice, speed]);

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;
    lifetime.current = new AbortController();
    const sessionIntent = intent.current;
    const controller = lifetime.current;
    audio.ontimeupdate = () => setTime(audio.currentTime);
    audio.ondurationchange = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    audio.onerror = () => {
      loadedVoice.current = null;
      intent.current.playing = false;
      setPlaying(false);
      setLoading(false);
      setFailed(true);
    };
    return () => {
      controller.abort();
      sessionIntent.epoch++;
      sessionIntent.playing = false;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  const prepare = useCallback(
    ({
      blockIndex,
      requestedVoice,
      epoch,
      background,
    }: {
      blockIndex: number;
      requestedVoice: string;
      epoch: number;
      /** Prefetches wait in line; the block about to play starts at once. */
      background: boolean;
    }) => {
      const controller = lifetime.current;
      if (!controller) throw new Error('Playback session is not mounted');
      const signal = controller.signal;
      const task = (background ? queue.current : Promise.resolve()).then(async () => {
        signal.throwIfAborted();
        if (epoch !== intent.current.epoch) return null;
        const target = { projectId, sectionId };
        let playback = playbackRef.current ?? (await getLessonPlayback(target, signal));
        const cacheKey = () => `${playback.lessonKey}:${blockIndex}:${requestedVoice}`;
        const cached = ready.current.get(cacheKey());
        if (cached) return cached;
        const request = () => {
          const block = playback.blocks[blockIndex];
          if (!block) throw new Error('Playback block missing');
          return prepareLessonPlayback(
            { ...target, blockId: block.id, lessonKey: playback.lessonKey, voice: requestedVoice },
            signal
          );
        };
        let result: Awaited<ReturnType<typeof prepareLessonPlayback>>;
        try {
          result = await request();
        } catch (error) {
          if (!(error instanceof LessonPlaybackRequestError) || error.status !== 409) throw error;
          playback = await getLessonPlayback(target, signal);
          if (loadedVoice.current || blockIndex > 0) {
            // A regenerated lesson cannot share the old recording's captions or note anchors.
            intent.current.epoch++;
            intent.current.index = 0;
            intent.current.playing = false;
            loadedVoice.current = null;
            playbackRef.current = playback;
            const audio = getAudio();
            audio.pause();
            audio.currentTime = 0;
            setBlocks(playback.blocks);
            setIndex(0);
            setTime(0);
            setDuration(0);
            setPlaying(false);
            setLoading(false);
            return null;
          }
          result = await request();
        }
        while ('runId' in result) {
          await waitForLessonPlayback(result.runId, projectId, signal);
          playback = await getLessonPlayback(target, signal);
          result = await request();
        }
        signal.throwIfAborted();
        const preparedBlock = result.block;
        // Preparations can overlap: merge into the latest lesson so a parallel one is not lost.
        const base =
          playbackRef.current?.lessonKey === playback.lessonKey ? playbackRef.current : playback;
        playback = {
          ...base,
          blocks: base.blocks.map(block => (block.id === preparedBlock.id ? preparedBlock : block)),
        };
        ready.current.set(cacheKey(), preparedBlock);
        playbackRef.current = playback;
        setBlocks(playback.blocks);
        return playback.blocks[blockIndex];
      });
      if (background) {
        // A failed preparation releases the queue; the learner can retry the same block.
        queue.current = task.catch(() => undefined);
      }
      return task;
    },
    [getAudio, projectId, sectionId]
  );

  const pause = useCallback(() => {
    const audio = getAudio();
    intent.current.playing = false;
    audio.pause();
    setPlaying(false);
  }, [getAudio]);

  const start = useCallback(
    async (blockIndex: number, offset = 0) => {
      const audio = getAudio();
      started.current = true;
      const epoch = ++intent.current.epoch;
      const requestedVoice = latest.current.voice;
      intent.current.index = blockIndex;
      setIndex(blockIndex);
      setTime(offset);
      setDuration(0);
      setLoading(true);
      setFailed(false);
      audio.pause();
      loadedVoice.current = null;
      try {
        const block = await prepare({ blockIndex, requestedVoice, epoch, background: false });
        if (!block || epoch !== intent.current.epoch) return;
        const recording = block.audio.find(candidate => candidate.voice === requestedVoice);
        if (!recording) throw new Error('Prepared playback audio missing');
        const bytes = await downloadProjectAssetBytes(
          projectId,
          recording.asset,
          lifetime.current?.signal
        );
        if (epoch !== intent.current.epoch) return;
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(
          new Blob([Uint8Array.from(bytes)], { type: recording.asset.mediaType })
        );
        audio.src = objectUrl.current;
        audio.currentTime = Math.min(offset, recording.durationSeconds);
        audio.playbackRate = latest.current.speed;
        setDuration(recording.durationSeconds);
        loadedVoice.current = requestedVoice;
        if (intent.current.playing) {
          await audio.play();
          if (epoch !== intent.current.epoch) return;
          if (!intent.current.playing) {
            audio.pause();
            return;
          }
          setPlaying(true);
          if (blockIndex + 1 < (playbackRef.current?.blocks.length ?? 0)) {
            void prepare({
              blockIndex: blockIndex + 1,
              requestedVoice,
              epoch,
              background: true,
            }).catch(error => {
              if (epoch !== intent.current.epoch || lifetime.current?.signal.aborted) return;
              console.error('Lesson playback preparation failed', error);
              setFailed(true);
            });
          }
        }
      } catch (error) {
        if (epoch !== intent.current.epoch || lifetime.current?.signal.aborted) return;
        console.error('Lesson playback failed', error);
        pause();
        setFailed(true);
      } finally {
        if (epoch === intent.current.epoch && !lifetime.current?.signal.aborted) setLoading(false);
      }
    },
    [getAudio, pause, prepare, projectId]
  );

  const play = useCallback(async () => {
    const audio = getAudio();
    intent.current.playing = true;
    if (!loadedVoice.current || loadedVoice.current !== latest.current.voice) {
      await start(intent.current.index, audio.currentTime);
      return;
    }
    try {
      await audio.play();
      if (!intent.current.playing) {
        audio.pause();
        return;
      }
      setPlaying(true);
      setFailed(false);
      const next = intent.current.index + 1;
      if (next < (playbackRef.current?.blocks.length ?? 0)) {
        void prepare({
          blockIndex: next,
          requestedVoice: latest.current.voice,
          epoch: intent.current.epoch,
          background: true,
        }).catch(error => {
          if (lifetime.current?.signal.aborted) return;
          console.error('Lesson playback preparation failed', error);
          setFailed(true);
        });
      }
    } catch (error) {
      console.error('Lesson playback start failed', error);
      pause();
      setFailed(true);
    }
  }, [getAudio, pause, prepare, start]);

  useEffect(() => {
    const audio = getAudio();
    audio.onended = () => {
      const next = intent.current.index + 1;
      if (next < (playbackRef.current?.blocks.length ?? 0)) void start(next);
      else {
        pause();
        loadedVoice.current = null;
        intent.current.index = 0;
        audio.currentTime = 0;
      }
    };
    return () => {
      audio.onended = null;
    };
  }, [getAudio, pause, start]);

  useEffect(() => {
    const audio = getAudio();
    audio.playbackRate = speed;
  }, [getAudio, speed]);
  useEffect(() => {
    if (previousVoice.current === voice) return;
    previousVoice.current = voice;
    if (started.current) void start(intent.current.index, getAudio().currentTime);
  }, [getAudio, start, voice]);

  const timeline = useMemo(() => playbackTimeline(blocks, voice), [blocks, voice]);
  const readTime = useCallback(() => getAudio().currentTime, [getAudio]);
  const elapsed = timeline.slice(0, index).reduce((sum, block) => sum + block.duration, 0) + time;
  const total = timeline.reduce((sum, block) => sum + block.duration, 0);
  const seek = (target: number) => {
    const audio = getAudio();
    if (!started.current) return;
    let offset = Math.max(0, Math.min(total, target));
    let next = 0;
    while (next < timeline.length - 1 && offset >= timeline[next].duration) {
      offset -= timeline[next].duration;
      next++;
    }
    if (next !== index) {
      void start(next, offset);
      return;
    }
    audio.currentTime = Math.min(duration, offset);
    setTime(audio.currentTime);
  };
  return {
    blocks,
    index,
    time,
    duration,
    elapsed,
    total,
    estimated: timeline.some(block => block.estimated),
    playing,
    loading,
    failed,
    play,
    pause,
    seek,
    readTime,
  };
}
