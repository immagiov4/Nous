import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  cancelLessonPlaybackPreparation,
  getLessonPlayback,
  LessonPlaybackRequestError,
  prepareLessonPlayback,
  waitForLessonPlayback,
} from '../../services/openrouter/lessonPlaybackClient.ts';
import { downloadProjectAssetBytes } from '../../services/projects/projectAssetClient.ts';
import { playbackTimeline } from '../../utils/reader/lessonPlayback.ts';
import {
  PlaybackPreparationQueue,
  playbackBufferIndexes,
  waitForPlaybackCancellation,
} from '../../utils/reader/lessonPlaybackBuffer.ts';

type Playback = Awaited<ReturnType<typeof getLessonPlayback>>;
type PreparedPlayback = Extract<
  Awaited<ReturnType<typeof prepareLessonPlayback>>,
  { block: unknown }
> & { url: string };

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

/** A creation response must remain observable so a late owned run can still be cancelled. */
async function requestPreparation({
  target,
  signal,
  cancellations,
  key,
  projectId,
}: {
  target: Parameters<typeof prepareLessonPlayback>[0];
  signal: AbortSignal;
  cancellations: Map<string, Promise<void>>;
  key: string;
  projectId: string;
}) {
  const pending = prepareLessonPlayback(target);
  const cancel = () => {
    const cancellation = pending.then(async result => {
      if ('runId' in result && result.created)
        await cancelLessonPlaybackPreparation(result.runId, projectId);
    });
    trackCancellation(cancellations, key, cancellation);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await waitForPlaybackCancellation(
      pending.then(() => {}),
      signal
    );
    return await pending;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function trackCancellation(
  cancellations: Map<string, Promise<void>>,
  key: string,
  cancellation: Promise<void>
) {
  cancellations.set(key, cancellation);
  void cancellation
    .finally(() => {
      if (cancellations.get(key) === cancellation) cancellations.delete(key);
    })
    .catch(error => console.error('Lesson playback cancellation failed', error));
}

/** Keeps cancellation ownership and the active recording key together until cancellation settles. */
async function waitForPreparation({
  runId,
  projectId,
  signal,
  created,
  cancellations,
  key,
}: {
  runId: string;
  projectId: string;
  signal: AbortSignal;
  created?: boolean;
  cancellations: Map<string, Promise<void>>;
  key: string;
}) {
  const cancel = () => {
    const cancellation = cancelLessonPlaybackPreparation(runId, projectId);
    trackCancellation(cancellations, key, cancellation);
  };
  if (created) signal.addEventListener('abort', cancel, { once: true });
  try {
    await waitForLessonPlayback(runId, projectId, signal);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** Alternates preloaded audio elements and owns cancellable, duration-based preparation. */
export function useLessonPlayback({
  projectId,
  sectionId,
  voice,
  speed,
  initialBlocks,
  audioElementRef,
  nextAudioElementRef,
}: {
  projectId: string;
  sectionId: string;
  voice: string;
  speed: number;
  initialBlocks: LessonPlaybackBlock[];
  audioElementRef?: RefObject<HTMLAudioElement>;
  nextAudioElementRef?: RefObject<HTMLAudioElement>;
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
  const queue = useRef(new PlaybackPreparationQueue());
  const pending = useRef(new Map<string, Promise<PreparedPlayback | null>>());
  const spareAudio = useRef<HTMLAudioElement | null>(null);
  const advance = useRef<() => void>(() => {});
  const refill = useRef<() => Promise<unknown>>(() => Promise.resolve());
  const preparationController = useRef<AbortController | null>(null);
  const prefetchFailed = useRef(false);
  const cancellations = useRef(new Map<string, Promise<void>>());
  const intent = useRef({ playing: false, index: 0, epoch: 0 });
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

  const bindAudio = useCallback((audio: HTMLAudioElement) => {
    audio.ontimeupdate = () => {
      if (audio !== audioRef.current) return;
      setTime(audio.currentTime);
      void refill.current();
    };
    audio.ondurationchange = () => {
      if (audio === audioRef.current && Number.isFinite(audio.duration))
        setDuration(audio.duration);
    };
    audio.onended = () => {
      if (audio === audioRef.current) advance.current();
    };
    audio.onerror = () => {
      if (audio !== audioRef.current) return;
      preparationController.current?.abort();
      if (loadedVoice.current)
        targetPosition.current = { offset: audio.currentTime, relative: false };
      loadedVoice.current = null;
      intent.current.playing = false;
      setPlaying(false);
      setLoading(false);
      setFailed(true);
    };
  }, []);

  useLayoutEffect(() => {
    audioRef.current = audioElementRef?.current ?? new Audio();
    const audio = getAudio();
    const sessionIntent = intent.current;
    const recordingCache = ready.current;
    bindAudio(audio);
    spareAudio.current = nextAudioElementRef?.current ?? new Audio();
    bindAudio(spareAudio.current);
    return () => {
      preparationController.current?.abort();
      sessionIntent.epoch++;
      sessionIntent.playing = false;
      const current = getAudio();
      current.pause();
      current.removeAttribute('src');
      current.load();
      spareAudio.current?.pause();
      spareAudio.current?.removeAttribute('src');
      spareAudio.current?.load();
      for (const prepared of recordingCache.values()) URL.revokeObjectURL(prepared.url);
      recordingCache.clear();
    };
  }, [audioElementRef, nextAudioElementRef, bindAudio, getAudio]);

  const beginPlaybackAttempt = useCallback((continuing = false) => {
    if (continuing && preparationController.current)
      return { epoch: intent.current.epoch, signal: preparationController.current.signal };
    prefetchFailed.current = false;
    pending.current.clear();
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
      signal,
    }: {
      blockIndex: number;
      requestedVoice: string;
      epoch: number;
      signal: AbortSignal;
    }) => {
      const cached =
        playbackRef.current &&
        ready.current.get(`${playbackRef.current.lessonKey}:${blockIndex}:${requestedVoice}`);
      if (cached) return Promise.resolve(cached);
      const pendingKey = `${epoch}:${blockIndex}:${requestedVoice}`;
      const existing = pending.current.get(pendingKey);
      if (existing) return existing;
      const task = queue.current.run(async () => {
        signal.throwIfAborted();
        if (epoch !== intent.current.epoch) return null;
        const target = { projectId, sectionId };
        let playback = playbackRef.current ?? (await getLessonPlayback(target, signal));
        playbackRef.current ??= playback;
        const cacheKey = () => `${playback.lessonKey}:${blockIndex}:${requestedVoice}`;
        const preparationKey = () => `${playback.lessonKey}:${blockIndex}`;
        await waitForPlaybackCancellation(cancellations.current.get(preparationKey()), signal);
        signal.throwIfAborted();
        const cached = ready.current.get(cacheKey());
        if (cached) return cached;
        const request = () => {
          const block = playback.blocks[blockIndex];
          if (!block) throw new Error('Playback block missing');
          return requestPreparation({
            target: {
              ...target,
              blockId: block.id,
              lessonKey: playback.lessonKey,
              voice: requestedVoice,
            },
            signal,
            cancellations: cancellations.current,
            key: preparationKey(),
            projectId,
          });
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
            if (!loadedVoice.current && intent.current.index === 0) {
              playbackRef.current = playback;
              return blockIndex === 0 ? request() : null;
            }
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
          await waitForPreparation({
            runId: result.runId,
            created: result.created,
            projectId,
            signal,
            cancellations: cancellations.current,
            key: preparationKey(),
          });
          signal.throwIfAborted();
          result = await requestCurrent();
          signal.throwIfAborted();
          if (!result) return null;
        }
        if (playbackRef.current && playbackRef.current.lessonKey !== playback.lessonKey)
          return null;
        const preparedBlock = result.block;
        const recording = preparedBlock.audio.find(
          audio => audio.voice === result.voice && audio.model === result.model
        );
        if (!recording) throw new Error('Prepared playback audio missing');
        const bytes = await downloadProjectAssetBytes(projectId, recording.asset, signal);
        signal.throwIfAborted();
        if (playbackRef.current && playbackRef.current.lessonKey !== playback.lessonKey)
          return null;
        const url = URL.createObjectURL(
          new Blob([Uint8Array.from(bytes)], { type: recording.asset.mediaType })
        );
        const prepared = { ...result, url };
        ready.current.set(cacheKey(), prepared);
        const profile = { voice: result.voice, model: result.model };
        setResolvedVoices(current => {
          const resolved = current.get(requestedVoice);
          if (resolved?.voice === profile.voice && resolved.model === profile.model) return current;
          return new Map(current).set(requestedVoice, profile);
        });
        // Preparations can overlap: merge into the latest lesson so a parallel one is not lost.
        const base =
          playbackRef.current?.lessonKey === playback.lessonKey ? playbackRef.current : playback;
        playback = {
          ...base,
          blocks: base.blocks.map(block => (block.id === preparedBlock.id ? preparedBlock : block)),
        };
        playbackRef.current = playback;
        setBlocks(playback.blocks);
        return prepared;
      }, signal);
      pending.current.set(pendingKey, task);
      // Retain a rejected task until the next user attempt so refill cannot repeat paid work.
      void task.then(
        () => pending.current.delete(pendingKey),
        () => undefined
      );
      return task;
    },
    [getAudio, projectId, sectionId]
  );

  const fillBuffer = useCallback(
    async (epoch: number, signal: AbortSignal) => {
      const playback = playbackRef.current;
      if (!playback || signal.aborted || epoch !== intent.current.epoch) return;
      const requestedVoice = latest.current.voice;
      const profile = resolvedVoices.get(requestedVoice);
      const indexes = playbackBufferIndexes(
        playbackTimeline(playback.blocks, profile?.voice ?? requestedVoice, profile?.model),
        intent.current.index,
        latest.current.speed
      );
      await Promise.all(
        indexes.map(async blockIndex => {
          const prepared = await prepare({ blockIndex, requestedVoice, epoch, signal });
          if (!prepared || signal.aborted || epoch !== intent.current.epoch) return;
          if (blockIndex === intent.current.index + 1 && spareAudio.current) {
            const spare = spareAudio.current;
            if (spare.src !== prepared.url) {
              spare.preload = 'auto';
              spare.playbackRate = latest.current.speed;
              spare.preservesPitch = true;
              spare.src = prepared.url;
              spare.load();
            }
          }
        })
      );
    },
    [prepare, resolvedVoices]
  );
  const refillBuffer = useCallback(async () => {
    const controller = preparationController.current;
    if (
      !intent.current.playing ||
      !controller ||
      controller.signal.aborted ||
      prefetchFailed.current
    )
      return;
    const epoch = intent.current.epoch;
    try {
      await fillBuffer(epoch, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || epoch !== intent.current.epoch) return;
      console.error('Lesson playback preparation failed', error);
      prefetchFailed.current = true;
      setFailed(true);
    }
  }, [fillBuffer]);
  useLayoutEffect(() => {
    refill.current = refillBuffer;
  }, [refillBuffer]);

  const pause = useCallback(() => {
    const audio = getAudio();
    intent.current.epoch++;
    preparationController.current?.abort();
    intent.current.playing = false;
    audio.pause();
    setPlaying(false);
    setLoading(false);
  }, [getAudio]);

  const prepareOpeningBuffer = useCallback(
    async ({
      blockIndex,
      requestedVoice,
      epoch,
      signal,
      profile,
      offset,
      relative,
    }: {
      blockIndex: number;
      requestedVoice: string;
      epoch: number;
      signal: AbortSignal;
      profile: { voice: string; model: string };
      offset: number;
      relative: boolean;
    }) => {
      const lessonKey = playbackRef.current?.lessonKey;
      let buffered = false;
      while (!buffered) {
        const playback = playbackRef.current;
        if (!playback) throw new Error('Playback metadata missing');
        if (playback.lessonKey !== lessonKey) return;
        const durations = playbackTimeline(playback.blocks, profile.voice, profile.model);
        const current = durations[blockIndex];
        durations[blockIndex] = {
          ...current,
          duration: Math.max(0, current.duration - (relative ? offset * current.duration : offset)),
        };
        const indexes = playbackBufferIndexes(durations, blockIndex - 1, latest.current.speed);
        buffered = indexes.every(index =>
          ready.current.has(`${playback.lessonKey}:${index}:${requestedVoice}`)
        );
        if (!buffered)
          await Promise.all(
            indexes.map(index => prepare({ blockIndex: index, requestedVoice, epoch, signal }))
          );
        signal.throwIfAborted();
      }
    },
    [prepare]
  );

  const activateRecording = useCallback(
    ({
      prepared,
      requestedVoice,
      offset,
      relative,
    }: {
      prepared: PreparedPlayback;
      requestedVoice: string;
      offset: number;
      relative: boolean;
    }) => {
      let audio = getAudio();
      const block = prepared.block;
      const recording = block.audio.find(
        candidate => candidate.voice === prepared.voice && candidate.model === prepared.model
      );
      if (!recording) throw new Error('Prepared playback audio missing');
      if (spareAudio.current?.src === prepared.url) {
        audioRef.current = spareAudio.current;
        spareAudio.current = audio;
        audio = getAudio();
      } else if (audio.src !== prepared.url) {
        audio.src = prepared.url;
      }
      if (audio.error) audio.load();
      const position = Math.min(
        relative ? offset * recording.durationSeconds : offset,
        recording.durationSeconds
      );
      if (audio.currentTime !== position) audio.currentTime = position;
      setTime(audio.currentTime);
      targetPosition.current = { offset: audio.currentTime, relative: false };
      audio.playbackRate = latest.current.speed;
      audio.preservesPitch = true;
      setDuration(recording.durationSeconds);
      loadedVoice.current = requestedVoice;
      return audio;
    },
    [getAudio]
  );

  const start = useCallback(
    async function start(
      blockIndex: number,
      offset = 0,
      relative = false,
      continuing = false
    ): Promise<void> {
      let audio = getAudio();
      started.current = true;
      const { epoch, signal } = beginPlaybackAttempt(continuing);
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
        if (!playbackRef.current)
          playbackRef.current = await getLessonPlayback({ projectId, sectionId }, signal);
        signal.throwIfAborted();
        const startingKey = playbackRef.current.lessonKey;
        const cached = ready.current.get(`${startingKey}:${blockIndex}:${requestedVoice}`);
        const current =
          cached ??
          prepare({
            blockIndex,
            requestedVoice,
            epoch,
            signal,
          });
        if (!continuing) void refill.current();
        // Keep a preloaded hand-off synchronous through play(), before React can render the scene.
        const prepared = cached ?? (await current);
        if (epoch !== intent.current.epoch || signal.aborted) return;
        if (playbackRef.current?.lessonKey !== startingKey) return start(0);
        if (!prepared) return;
        if (!continuing && intent.current.playing)
          await prepareOpeningBuffer({
            blockIndex,
            requestedVoice,
            epoch,
            signal,
            profile: prepared,
            offset,
            relative,
          });
        if (playbackRef.current?.lessonKey !== startingKey) return start(0);
        audio = activateRecording({ prepared, requestedVoice, offset, relative });
        if (!intent.current.playing) return;
        await audio.play();
        if (epoch !== intent.current.epoch || signal.aborted) return;
        setPlaying(true);
        void refill.current();
      } catch (error) {
        if (epoch !== intent.current.epoch || signal.aborted) return;
        console.error('Lesson playback failed', error);
        pause();
        setFailed(true);
      } finally {
        if (epoch === intent.current.epoch && !signal.aborted) setLoading(false);
      }
    },
    [
      activateRecording,
      beginPlaybackAttempt,
      getAudio,
      pause,
      prepare,
      prepareOpeningBuffer,
      projectId,
      sectionId,
    ]
  );

  const play = useCallback(async () => {
    const audio = getAudio();
    const sameVoice = loadedVoice.current === latest.current.voice;
    const position = sameVoice
      ? { offset: audio.currentTime, relative: false }
      : targetPosition.current;
    intent.current.playing = true;
    if (!sameVoice) {
      unlockLessonPlaybackAudio(audio);
      if (spareAudio.current) unlockLessonPlaybackAudio(spareAudio.current);
    }
    await start(intent.current.index, position.offset, position.relative);
  }, [getAudio, start]);

  useEffect(() => {
    advance.current = () => {
      const audio = getAudio();
      const next = intent.current.index + 1;
      if (next < (playbackRef.current?.blocks.length ?? 0)) void start(next, 0, false, true);
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
      advance.current = () => {};
    };
  }, [getAudio, pause, start]);

  useEffect(() => {
    const audio = getAudio();
    audio.playbackRate = speed;
    if (spareAudio.current) spareAudio.current.playbackRate = speed;
    void refill.current();
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
  // The audio element still belongs to the previous recording while a target is preparing.
  const readPosition = () => {
    if (loadedVoice.current) return { time: readTime(), duration };
    const { offset, relative } = targetPosition.current;
    return {
      time: offset,
      duration: relative ? 1 : (timeline[intent.current.index]?.duration ?? 0),
    };
  };
  const elapsed = timeline.slice(0, index).reduce((sum, block) => sum + block.duration, 0) + time;
  const total = timeline.reduce((sum, block) => sum + block.duration, 0);
  const seek = (target: number) => {
    if (!started.current) return;
    let offset = Math.max(0, Math.min(total, target));
    let next = 0;
    while (next < timeline.length - 1 && offset >= timeline[next].duration) {
      offset -= timeline[next].duration;
      next++;
    }
    void start(next, offset);
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
    readPosition,
  };
}
