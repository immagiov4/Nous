import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getLessonPlayback,
  LessonPlaybackRequestError,
  prepareLessonPlayback,
  waitForLessonPlayback,
} from '../../services/openrouter/lessonPlaybackClient.ts';
import { downloadProjectAssetBytes } from '../../services/projects/projectAssetClient.ts';

import { playbackTimeline } from '../../utils/reader/lessonPlayback.ts';

type Playback = Awaited<ReturnType<typeof getLessonPlayback>>;
type PreparedPlayback = Extract<
  Awaited<ReturnType<typeof prepareLessonPlayback>>,
  { block: unknown }
>;

// One silent PCM sample gives the gesture-time play a valid source before the MP3 is ready.
const SILENT_AUDIO =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';

/** Unlocks this element inside the opening or play gesture, before asynchronous preparation. */
export function unlockLessonPlaybackAudio(audio: HTMLAudioElement) {
  if (!audio.src) audio.src = SILENT_AUDIO;
  const muted = audio.muted;
  audio.muted = true;
  void audio.play().catch(error => {
    // Pausing immediately can reject the priming play; the prepared MP3 owns playback errors.
    if (error instanceof DOMException && error.name === 'AbortError') return;
    console.error('Lesson playback audio unlock failed', error);
  });
  audio.pause();
  audio.muted = muted;
}

/** Owns one audio element, cancellable playback attempts and a background preparation queue. */
export function useLessonPlayback({
  projectId,
  sectionId,
  voice,
  speed,
  initialBlocks,
  audioElementRef,
}: {
  projectId: string;
  sectionId: string;
  voice: string;
  speed: number;
  initialBlocks: LessonPlaybackBlock[];
  audioElementRef?: RefObject<HTMLAudioElement>;
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
  const preparationController = useRef<AbortController | null>(null);
  const intent = useRef({ playing: false, index: 0, epoch: 0 });
  const objectUrl = useRef<string | null>(null);
  const ready = useRef(new Map<string, PreparedPlayback>());
  const [resolvedVoices, setResolvedVoices] = useState(
    () => new Map<string, { voice: string; model: string }>()
  );
  const started = useRef(false);
  const previousVoice = useRef(voice);
  const loadedVoice = useRef<string | null>(null);
  const targetPosition = useRef({ offset: 0, relative: false });
  const latest = useRef({ voice, speed });
  useEffect(() => {
    latest.current = { voice, speed };
  }, [voice, speed]);

  useEffect(() => {
    audioRef.current = audioElementRef?.current ?? new Audio();
    const audio = getAudio();
    const sessionIntent = intent.current;
    audio.ontimeupdate = () => setTime(audio.currentTime);
    audio.ondurationchange = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    audio.onerror = () => {
      preparationController.current?.abort();
      if (loadedVoice.current) {
        targetPosition.current = { offset: audio.currentTime, relative: false };
      }
      loadedVoice.current = null;
      intent.current.playing = false;
      setPlaying(false);
      setLoading(false);
      setFailed(true);
    };
    return () => {
      preparationController.current?.abort();
      sessionIntent.epoch++;
      sessionIntent.playing = false;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, [audioElementRef, getAudio]);

  const beginPlaybackAttempt = useCallback(() => {
    preparationController.current?.abort();
    const controller = new AbortController();
    preparationController.current = controller;
    return { epoch: ++intent.current.epoch, signal: controller.signal };
  }, []);

  const prepare = useCallback(
    ({
      blockIndex,
      requestedVoice,
      epoch,
      background,
      signal,
    }: {
      blockIndex: number;
      requestedVoice: string;
      epoch: number;
      /** Prefetches wait in line; the block about to play starts at once. */
      background: boolean;
      signal: AbortSignal;
    }) => {
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
        const requestCurrent = async () => {
          signal.throwIfAborted();
          try {
            return await request();
          } catch (error) {
            if (!(error instanceof LessonPlaybackRequestError) || error.status !== 409) throw error;
            signal.throwIfAborted();
            playback = await getLessonPlayback(target, signal);
            signal.throwIfAborted();
            if (!loadedVoice.current && blockIndex === 0) return request();
            // A regenerated lesson cannot share the old recording's captions or note anchors.
            intent.current.epoch++;
            preparationController.current?.abort();
            intent.current.index = 0;
            targetPosition.current = { offset: 0, relative: false };
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
        };
        let result = await requestCurrent();
        signal.throwIfAborted();
        if (!result) return null;
        while ('runId' in result) {
          await waitForLessonPlayback(result.runId, projectId, signal);
          signal.throwIfAborted();
          playback = await getLessonPlayback(target, signal);
          result = await requestCurrent();
          signal.throwIfAborted();
          if (!result) return null;
        }
        const preparedBlock = result.block;
        // Preparations can overlap: merge into the latest lesson so a parallel one is not lost.
        const base =
          playbackRef.current?.lessonKey === playback.lessonKey ? playbackRef.current : playback;
        playback = {
          ...base,
          blocks: base.blocks.map(block => (block.id === preparedBlock.id ? preparedBlock : block)),
        };
        ready.current.set(cacheKey(), result);
        const profile = { voice: result.voice, model: result.model };
        setResolvedVoices(current => {
          const resolved = current.get(requestedVoice);
          if (resolved?.voice === profile.voice && resolved.model === profile.model) return current;
          return new Map(current).set(requestedVoice, profile);
        });
        playbackRef.current = playback;
        setBlocks(playback.blocks);
        return result;
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
    intent.current.epoch++;
    preparationController.current?.abort();
    intent.current.playing = false;
    audio.pause();
    setPlaying(false);
    setLoading(false);
  }, [getAudio]);

  const start = useCallback(
    async (blockIndex: number, offset = 0, relative = false) => {
      const audio = getAudio();
      started.current = true;
      const { epoch, signal } = beginPlaybackAttempt();
      const requestedVoice = latest.current.voice;
      intent.current.index = blockIndex;
      targetPosition.current = { offset, relative };
      setIndex(blockIndex);
      setTime(offset);
      setDuration(0);
      setLoading(true);
      setFailed(false);
      audio.pause();
      loadedVoice.current = null;
      try {
        const prepared = await prepare({
          blockIndex,
          requestedVoice,
          epoch,
          background: false,
          signal,
        });
        if (!prepared || epoch !== intent.current.epoch || signal.aborted) return;
        const block = prepared.block;
        const recording = block.audio.find(
          candidate => candidate.voice === prepared.voice && candidate.model === prepared.model
        );
        if (!recording) throw new Error('Prepared playback audio missing');
        const bytes = await downloadProjectAssetBytes(projectId, recording.asset, signal);
        if (epoch !== intent.current.epoch || signal.aborted) return;
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(
          new Blob([Uint8Array.from(bytes)], { type: recording.asset.mediaType })
        );
        audio.src = objectUrl.current;
        audio.currentTime = Math.min(
          relative ? offset * recording.durationSeconds : offset,
          recording.durationSeconds
        );
        setTime(audio.currentTime);
        targetPosition.current = { offset: audio.currentTime, relative: false };
        audio.playbackRate = latest.current.speed;
        setDuration(recording.durationSeconds);
        loadedVoice.current = requestedVoice;
        if (!intent.current.playing) return;
        await audio.play();
        if (epoch !== intent.current.epoch || signal.aborted) return;
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
            signal,
          }).catch(error => {
            if (epoch !== intent.current.epoch || signal.aborted) return;
            console.error('Lesson playback preparation failed', error);
            setFailed(true);
          });
        }
      } catch (error) {
        if (epoch !== intent.current.epoch || signal.aborted) return;
        console.error('Lesson playback failed', error);
        pause();
        setFailed(true);
      } finally {
        if (epoch === intent.current.epoch && !signal.aborted) setLoading(false);
      }
    },
    [beginPlaybackAttempt, getAudio, pause, prepare, projectId]
  );

  const play = useCallback(async () => {
    const audio = getAudio();
    intent.current.playing = true;
    if (!loadedVoice.current || loadedVoice.current !== latest.current.voice) {
      unlockLessonPlaybackAudio(audio);
      const { offset, relative } = targetPosition.current;
      await start(intent.current.index, offset, relative);
      return;
    }
    const { epoch, signal } = beginPlaybackAttempt();
    try {
      await audio.play();
      if (epoch !== intent.current.epoch || signal.aborted) return;
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
          epoch,
          background: true,
          signal,
        }).catch(error => {
          if (epoch !== intent.current.epoch || signal.aborted) return;
          console.error('Lesson playback preparation failed', error);
          setFailed(true);
        });
      }
    } catch (error) {
      if (epoch !== intent.current.epoch || signal.aborted) return;
      console.error('Lesson playback start failed', error);
      pause();
      setFailed(true);
    }
  }, [beginPlaybackAttempt, getAudio, pause, prepare, start]);

  useEffect(() => {
    const audio = getAudio();
    audio.onended = () => {
      const next = intent.current.index + 1;
      if (next < (playbackRef.current?.blocks.length ?? 0)) void start(next);
      else {
        pause();
        loadedVoice.current = null;
        intent.current.index = 0;
        targetPosition.current = { offset: 0, relative: false };
        audio.currentTime = 0;
        setIndex(0);
        setTime(0);
        setDuration(0);
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
    if (started.current) {
      const position = loadedVoice.current
        ? { offset: duration > 0 ? getAudio().currentTime / duration : 0, relative: true }
        : targetPosition.current;
      void start(intent.current.index, position.offset, position.relative);
    }
  }, [duration, getAudio, start, voice]);

  const timeline = useMemo(() => {
    const resolved = resolvedVoices.get(voice);
    return playbackTimeline(blocks, resolved?.voice ?? voice, resolved?.model);
  }, [blocks, resolvedVoices, voice]);
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
    if (next !== index || !loadedVoice.current) {
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
