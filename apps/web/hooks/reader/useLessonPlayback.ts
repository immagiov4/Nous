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
  subscribeToPlaybackChanges,
  waitForLessonPlayback,
} from '../../services/openrouter/lessonPlaybackClient.ts';
import { downloadProjectAssetBytes } from '../../services/projects/projectAssetClient.ts';
import { mergeRecordingAlignment, playbackTimeline } from '../../utils/reader/lessonPlayback.ts';
import {
  LessonPlaybackAudio,
  type PlaybackRecording,
} from '../../utils/reader/lessonPlaybackAudio.ts';
import {
  PlaybackPreparationQueue,
  playbackBufferIndexes,
  waitForPlaybackCancellation,
} from '../../utils/reader/lessonPlaybackBuffer.ts';
import { loadSceneIconNodes } from '../../utils/visuals/sceneIconNodes.ts';

// A player can close before its owned server cancellation settles.
const playbackCancellations = new Map<string, Promise<void>>();

type Playback = { lessonKey: string; blocks: readonly LessonPlaybackBlock[] };
type PreparedPlayback = {
  block: LessonPlaybackBlock;
  voice: string;
  model: string;
  buffer: AudioBuffer;
};

/** Merge timing revisions without replacing unchanged lesson or recording content. */
function recordingTimingUpdate(incoming: Playback) {
  const byId = new Map(incoming.blocks.map(block => [block.id, block]));
  const merge = (block: LessonPlaybackBlock) => mergeRecordingAlignment(block, byId.get(block.id));
  return {
    merge,
    blocks: (current: readonly LessonPlaybackBlock[]) => {
      const next = current.map(merge);
      return next.some((block, index) => block !== current[index]) ? next : current;
    },
  };
}

/** Resumes the audio clock synchronously inside the opening or play gesture. */
export function unlockLessonPlaybackAudio(audio: LessonPlaybackAudio) {
  void audio.unlock().catch(error => console.error('Lesson audio unlock failed', error));
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

/** Owns cancellable preparation and schedules decoded passages on one audio clock. */
export function useLessonPlayback({
  projectId,
  sectionId,
  voice,
  speed,
  initialBlocks,
  audioSessionRef,
}: {
  projectId: string;
  sectionId: string;
  voice: string;
  speed: number;
  initialBlocks: LessonPlaybackBlock[];
  audioSessionRef?: RefObject<LessonPlaybackAudio>;
}) {
  const [lessonKey, setLessonKey] = useState<string>();
  const [blocks, setBlocks] = useState<readonly LessonPlaybackBlock[]>(initialBlocks);
  const [index, setIndex] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekRevision, setSeekRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<LessonPlaybackAudio | null>(null);
  const getAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) throw new Error('Playback audio must be mounted');
    return audio;
  }, []);
  const playbackRef = useRef<Playback | null>(null);
  const latestRecordingTimings = useRef<Playback | null>(null);
  const queue = useRef(new PlaybackPreparationQueue());
  const pending = useRef(new Map<string, Promise<PreparedPlayback | null>>());
  const advance = useRef<() => void>(() => {});
  const refill = useRef<() => Promise<unknown>>(() => Promise.resolve());
  const preparationController = useRef<AbortController | null>(null);
  const prefetchFailed = useRef(false);
  const intent = useRef({ playing: false, index: 0, epoch: 0 });
  const ready = useRef(new Map<string, PreparedPlayback>());
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => {
      if (!playbackRef.current) return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      void getLessonPlayback({ projectId, sectionId }, request.signal)
        .then(incoming => {
          if (request.signal.aborted || incoming.lessonKey !== playbackRef.current?.lessonKey)
            return;
          latestRecordingTimings.current = incoming;
          const update = recordingTimingUpdate(incoming);
          for (const [key, prepared] of ready.current) {
            const block = update.merge(prepared.block);
            if (block !== prepared.block) ready.current.set(key, { ...prepared, block });
          }
          playbackRef.current = {
            ...playbackRef.current,
            blocks: update.blocks(playbackRef.current.blocks),
          };
          setBlocks(update.blocks);
        })
        .catch(error => {
          if (!request.signal.aborted) console.warn('Could not refresh recording timing.', error);
        });
    };
    const stop = subscribeToPlaybackChanges(projectId, refresh);
    return () => {
      stop();
      controller?.abort();
    };
  }, [projectId, sectionId]);
  const isCurrentAttempt = useCallback(
    (epoch: number, signal: AbortSignal) => epoch === intent.current.epoch && !signal.aborted,
    []
  );

  const [resolvedVoices, setResolvedVoices] = useState(
    () => new Map<string, { voice: string; model: string }>()
  );
  const started = useRef(false);
  const activeStart = useRef(0);
  const previousVoice = useRef(voice);
  const loadedVoice = useRef<string | null>(null);
  const targetPosition = useRef({ offset: 0, relative: false });
  const latest = useRef({ voice, speed });
  useEffect(() => {
    latest.current = { voice, speed };
  }, [voice, speed]);

  const audioLifecycle = useRef({ generation: 0 });
  useLayoutEffect(() => {
    const lifecycleState = audioLifecycle.current;
    const lifecycle = ++lifecycleState.generation;
    audioRef.current ??= audioSessionRef?.current ?? new LessonPlaybackAudio();
    const audio = getAudio();
    const sessionIntent = intent.current;
    const recordingCache = ready.current;
    audio.onPosition = position => {
      sessionIntent.index = position.index;
      setIndex(position.index);
      setTime(position.time);
      setDuration(position.duration);
      void refill.current();
    };
    audio.onEnded = () => advance.current();
    audio.onError = () => {
      preparationController.current?.abort();
      sessionIntent.playing = false;
      setPlaying(false);
      setLoading(false);
      setFailed(true);
    };
    return () => {
      preparationController.current?.abort();
      sessionIntent.epoch++;
      sessionIntent.playing = false;
      audio.pause();
      audio.onPosition = null;
      audio.onEnded = null;
      audio.onError = null;
      recordingCache.clear();
      // React can reconnect the same effect in development before this microtask runs.
      queueMicrotask(() => {
        if (!audioSessionRef && lifecycleState.generation === lifecycle) audio.close();
      });
    };
  }, [audioSessionRef, getAudio]);

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
      if (existing !== undefined) return existing;
      const task = queue.current.run(async () => {
        signal.throwIfAborted();
        if (epoch !== intent.current.epoch) return null;
        const target = { projectId, sectionId };
        let playback = playbackRef.current ?? (await getLessonPlayback(target, signal));
        playbackRef.current ??= playback;
        const cacheKey = () => `${playback.lessonKey}:${blockIndex}:${requestedVoice}`;
        const preparationKey = () =>
          `${projectId}:${sectionId}:${playback.lessonKey}:${blockIndex}`;
        await waitForPlaybackCancellation(playbackCancellations.get(preparationKey()), signal);
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
            cancellations: playbackCancellations,
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
              setLessonKey(playback.lessonKey);
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
            setLessonKey(playback.lessonKey);
            const audio = getAudio();
            audio.pause();
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
            cancellations: playbackCancellations,
            key: preparationKey(),
          });
          signal.throwIfAborted();
          result = await requestCurrent();
          signal.throwIfAborted();
          if (!result) return null;
        }
        if (playbackRef.current && playbackRef.current.lessonKey !== playback.lessonKey)
          return null;
        let preparedBlock: LessonPlaybackBlock = result.block;
        const recording = preparedBlock.audio.find(
          audio => audio.voice === result.voice && audio.model === result.model
        );
        if (!recording) throw new Error('Prepared playback audio missing');
        const bytes = await downloadProjectAssetBytes(projectId, recording.asset, signal);
        signal.throwIfAborted();
        if (playbackRef.current && playbackRef.current.lessonKey !== playback.lessonKey)
          return null;
        const buffer = await getAudio().decode(bytes);
        signal.throwIfAborted();
        if (playbackRef.current && playbackRef.current.lessonKey !== playback.lessonKey)
          return null;
        const latestTimings = latestRecordingTimings.current;
        if (latestTimings?.lessonKey === playback.lessonKey) {
          preparedBlock = mergeRecordingAlignment(
            preparedBlock,
            latestTimings.blocks.find(block => block.id === preparedBlock.id)
          );
        }
        const prepared = { ...result, block: preparedBlock, buffer };
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
        setLessonKey(playback.lessonKey);
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

  const bufferedRecordings = useCallback(() => {
    const playback = playbackRef.current;
    const recordings: PlaybackRecording[] = [];
    if (!playback) return recordings;
    for (let index = intent.current.index; index < playback.blocks.length; index++) {
      const prepared = ready.current.get(`${playback.lessonKey}:${index}:${latest.current.voice}`);
      if (!prepared) break;
      recordings.push({ index, buffer: prepared.buffer });
    }
    return recordings;
  }, []);

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
          await prepare({ blockIndex, requestedVoice, epoch, signal });
          if (!signal.aborted && epoch === intent.current.epoch)
            await getAudio().append(bufferedRecordings());
        })
      );
    },
    [prepare, resolvedVoices, getAudio, bufferedRecordings]
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

  const start = useCallback(
    async function start(
      blockIndex: number,
      offset = 0,
      relative = false,
      continuing = false
    ): Promise<void> {
      const audio = getAudio();
      started.current = true;
      const { epoch, signal } = beginPlaybackAttempt(continuing);
      const startId = ++activeStart.current;
      // A continuation shares preparation ownership, but owns its loading state.
      const isCurrentStart = () =>
        startId === activeStart.current && isCurrentAttempt(epoch, signal);
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
        const visualAssets = loadSceneIconNodes().catch(error => {
          // Decorative paths can fail while the complete scene text remains available.
          console.error('Lesson scene icons could not be loaded.', error);
        });
        if (!playbackRef.current)
          playbackRef.current = await getLessonPlayback({ projectId, sectionId }, signal);
        signal.throwIfAborted();
        setLessonKey(playbackRef.current.lessonKey);
        const startingKey = playbackRef.current.lessonKey;
        const current = prepare({ blockIndex, requestedVoice, epoch, signal });
        if (!continuing) void refill.current();
        // A ready recording bypasses preparation while preserving the active attempt.
        const prepared = await current;
        if (!isCurrentStart()) return;
        if (playbackRef.current?.lessonKey !== startingKey) return start(0);
        if (!prepared) return;
        const position = Math.min(
          relative ? offset * prepared.buffer.duration : offset,
          prepared.buffer.duration
        );
        setTime(position);
        setDuration(prepared.buffer.duration);
        targetPosition.current = { offset: position, relative: false };
        loadedVoice.current = requestedVoice;
        if (!intent.current.playing) {
          audio.select({ index: blockIndex, buffer: prepared.buffer }, position);
          return;
        }
        if (prepared.block.prepared?.scene) await visualAssets;
        if (!isCurrentStart()) return;
        await audio.start(bufferedRecordings(), position, latest.current.speed, signal);
        if (!isCurrentStart()) return;
        setPlaying(true);
        void refill.current();
      } catch (error) {
        if (!isCurrentStart()) return;
        console.error('Lesson playback failed', error);
        pause();
        setFailed(true);
      } finally {
        if (isCurrentStart()) setLoading(false);
      }
    },
    [
      bufferedRecordings,
      beginPlaybackAttempt,
      isCurrentAttempt,
      getAudio,
      pause,
      prepare,
      projectId,
      sectionId,
    ]
  );

  const play = useCallback(async () => {
    const audio = getAudio();
    unlockLessonPlaybackAudio(audio);
    const position = loadedVoice.current ? audio.position : null;
    const target = position ? { offset: position.time, relative: false } : targetPosition.current;
    intent.current.playing = true;
    await start(position?.index ?? intent.current.index, target.offset, target.relative);
  }, [getAudio, start]);

  useEffect(() => {
    advance.current = () => {
      const next = intent.current.index + 1;
      if (next < (playbackRef.current?.blocks.length ?? 0)) void start(next, 0, false, true);
      else {
        pause();
        loadedVoice.current = null;
        intent.current.index = 0;
        targetPosition.current = { offset: 0, relative: false };
        setIndex(0);
        setTime(0);
        setDuration(0);
      }
    };
    return () => {
      advance.current = () => {};
    };
  }, [pause, start]);

  useEffect(() => {
    getAudio().changeSpeed(speed);
    void refill.current();
  }, [getAudio, speed]);
  useEffect(() => {
    if (previousVoice.current === voice) return;
    previousVoice.current = voice;
    if (started.current) {
      const current = loadedVoice.current ? getAudio().position : null;
      const position = current
        ? { offset: current.duration > 0 ? current.time / current.duration : 0, relative: true }
        : targetPosition.current;
      void start(current?.index ?? intent.current.index, position.offset, position.relative);
    }
  }, [getAudio, start, voice]);

  const timeline = useMemo(() => {
    const resolved = resolvedVoices.get(voice);
    return playbackTimeline(blocks, resolved?.voice ?? voice, resolved?.model);
  }, [blocks, resolvedVoices, voice]);
  const readTime = useCallback(() => {
    // Child layout effects read the clock before the parent mounts its audio session.
    const position = audioRef.current?.position;
    if (!position) return 0;
    return position.index === index ? position.time : duration;
  }, [index, duration]);
  const readPosition = () => {
    const position = loadedVoice.current ? getAudio().position : null;
    if (position) return position;
    const { offset, relative } = targetPosition.current;
    return {
      index: intent.current.index,
      time: offset,
      duration: relative ? 1 : (timeline[intent.current.index]?.duration ?? 0),
    };
  };
  const elapsed = timeline.slice(0, index).reduce((sum, block) => sum + block.duration, 0) + time;
  const total = timeline.reduce((sum, block) => sum + block.duration, 0);
  const seek = (target: number) => {
    if (!started.current) return;
    setSeekRevision(revision => revision + 1);
    let offset = Math.max(0, Math.min(total, target));
    let next = 0;
    while (next < timeline.length - 1 && offset >= timeline[next].duration) {
      offset -= timeline[next].duration;
      next++;
    }
    void start(next, offset);
  };
  return {
    lessonKey,
    blocks,
    recording: blocks[index]?.audio.find(audio => {
      const resolved = resolvedVoices.get(voice);
      return audio.voice === resolved?.voice && audio.model === resolved.model;
    }),
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
    seekRevision,
    readPosition,
  };
}
