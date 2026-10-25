// @vitest-environment jsdom

import { type LessonPlaybackBlock, segmentLessonPlayback } from '@shared/lessonPlayback';
import { LessonPlaybackResponseSchema } from '@shared/lessonPlaybackSchema';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useLessonPlayback } from '../../../hooks/reader/useLessonPlayback.ts';
import {
  cancelLessonPlaybackPreparation,
  getLessonPlayback,
  LessonPlaybackRequestError,
  prepareLessonPlayback,
  subscribeToPlaybackChanges,
  waitForLessonPlayback,
} from '../../../services/openrouter/lessonPlaybackClient.ts';
import { downloadProjectAssetBytes } from '../../../services/projects/projectAssetClient.ts';
import type { LessonPlaybackAudio } from '../../../utils/reader/lessonPlaybackAudio.ts';
import { loadSceneIconNodes } from '../../../utils/visuals/sceneIconNodes.ts';

vi.mock('../../../utils/visuals/sceneIconNodes.ts', () => ({
  loadSceneIconNodes: vi.fn(async () => ({})),
}));

vi.mock('../../../services/openrouter/lessonPlaybackClient.ts', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../../services/openrouter/lessonPlaybackClient.ts')
  >()),
  cancelLessonPlaybackPreparation: vi.fn().mockResolvedValue(undefined),
  getLessonPlayback: vi.fn(),
  prepareLessonPlayback: vi.fn(),
  waitForLessonPlayback: vi.fn(),
  subscribeToPlaybackChanges: vi.fn(() => () => {}),
}));
vi.mock('../../../services/projects/projectAssetClient.ts', () => ({
  downloadProjectAssetBytes: vi.fn(),
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise is not initialized');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('Deferred promise is not initialized');
  };
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const blocks = LessonPlaybackResponseSchema.parse({
  lessonKey: 'a'.repeat(64),
  blocks: segmentLessonPlayback([
    { type: 'markdown', markdown: 'Prima frase.\n\nSeconda frase.\n\nTerza frase.' },
  ]).map(block => ({
    ...block,
    audio: [
      {
        voice: 'Kore',
        model: 'tts',
        durationSeconds: 10,
        asset: { id: 'a'.repeat(64), hash: 'a'.repeat(64), byteSize: 1, mediaType: 'audio/mpeg' },
      },
    ],
  })),
}).blocks;
const target = {
  projectId: 'project',
  sectionId: 'lesson',
  voice: 'Kore',
  speed: 1,
  initialBlocks: blocks,
};
let audio: FakePlaybackAudio;
let projectSequence = 0;
class FakePlaybackAudio {
  position = { index: 0, time: 0, duration: 10 };
  paused = true;
  recordings: { index: number; buffer: AudioBuffer }[] = [];
  onPosition: ((position: FakePlaybackAudio['position']) => void) | null = null;
  onEnded: (() => void) | null = null;
  onError: ((error: unknown) => void) | null = null;
  unlock = vi.fn(async () => {});
  decode = vi.fn(async (bytes: Uint8Array) => ({ duration: 10, bytes }) as unknown as AudioBuffer);
  pause = vi.fn(() => {
    this.paused = true;
  });
  close = vi.fn(() => this.pause());
  select = vi.fn((recording: { index: number; buffer: AudioBuffer }, time: number) => {
    this.position = { index: recording.index, time, duration: recording.buffer.duration };
  });
  start = vi.fn(async (recordings: FakePlaybackAudio['recordings'], offset: number) => {
    this.recordings = [...recordings];
    this.paused = false;
    this.select(recordings[0], offset);
    this.onPosition?.(this.position);
  });
  append = vi.fn(async (_recordings: FakePlaybackAudio['recordings']) => {});
  changeSpeed = vi.fn();
  moveTo(index: number, time = 0) {
    const recording = this.recordings.find(recording => recording.index === index);
    if (!recording) throw new Error('Passage not buffered');
    this.position = { index, time, duration: recording.buffer.duration };
    this.onPosition?.(this.position);
  }
}
vi.mock('../../../utils/reader/lessonPlaybackAudio.ts', () => ({
  LessonPlaybackAudio: vi.fn(function MockLessonPlaybackAudio() {
    return audio;
  }),
}));

beforeEach(() => {
  vi.mocked(loadSceneIconNodes).mockReset().mockResolvedValue({});
  for (const mock of [
    cancelLessonPlaybackPreparation,
    getLessonPlayback,
    prepareLessonPlayback,
    waitForLessonPlayback,
    downloadProjectAssetBytes,
  ])
    vi.mocked(mock).mockReset();
  vi.mocked(cancelLessonPlaybackPreparation).mockResolvedValue(undefined);
  target.projectId = `project-${++projectSequence}`;
  audio = new FakePlaybackAudio();
  vi.mocked(getLessonPlayback).mockResolvedValue({ lessonKey: 'a'.repeat(64), blocks });
  vi.mocked(prepareLessonPlayback).mockImplementation(async request => ({
    block: blocks[Number(request.blockId)],
    voice: 'Kore',
    model: 'tts',
  }));
  vi.mocked(waitForLessonPlayback).mockResolvedValue(undefined);
  vi.mocked(downloadProjectAssetBytes).mockResolvedValue(new Uint8Array([1]));
});

function activeAudio() {
  expect(audio.paused).toBe(false);
  return audio;
}
function pendingUntilAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

const sceneBlocks = blocks.map(block => ({
  ...block,
  prepared: {
    motion: [],
    scene: {
      type: 'parts' as const,
      title: 'Concetti',
      body: '',
      items: [{ icon: 'point', label: 'Prima', detail: '' }],
      groups: [],
      note: '',
      quote: '',
    },
  },
}));

test('starts text-only playback while scene paths remain pending', async () => {
  vi.mocked(loadSceneIconNodes).mockReturnValueOnce(new Promise(() => {}));
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(result.current.loading).toBe(false);
});

test('loads scene paths after Play and waits for them while preparing audio', async () => {
  vi.mocked(prepareLessonPlayback).mockImplementation(async request => ({
    block: sceneBlocks[Number(request.blockId)],
    voice: 'Kore',
    model: 'tts',
  }));
  const paths = deferred<Awaited<ReturnType<typeof loadSceneIconNodes>>>();
  vi.mocked(loadSceneIconNodes).mockReturnValueOnce(paths.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  expect(loadSceneIconNodes).not.toHaveBeenCalled();
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(downloadProjectAssetBytes).toHaveBeenCalled());
  expect(audio.start).not.toHaveBeenCalled();
  await act(async () => paths.resolve({}));
  expect(audio.start).toHaveBeenCalledOnce();
});

test('keeps complete scene text and audio available when decorative paths fail', async () => {
  vi.mocked(loadSceneIconNodes).mockRejectedValueOnce(new Error('Asset unavailable'));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { result } = renderHook(() => useLessonPlayback(target));
    await act(async () => result.current.play());
    expect(audio.start).toHaveBeenCalledOnce();
    expect(result.current.failed).toBe(false);
    expect(logged).toHaveBeenCalledOnce();
  } finally {
    logged.mockRestore();
  }
});

test('prefetches thirty seconds and supplies ready contiguous recordings', async () => {
  const first = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback).mockReturnValueOnce(first.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalled());
  expect(result.current.loading).toBe(true);
  expect(audio.start).not.toHaveBeenCalled();
  await act(async () => first.resolve({ block: blocks[0], voice: 'Kore', model: 'tts' }));
  expect(audio.recordings.map(recording => recording.index)).toEqual([0, 1, 2]);
  expect(downloadProjectAssetBytes).toHaveBeenCalledTimes(3);
  const starts = audio.start.mock.calls.length;
  act(() => audio.moveTo(1));
  expect(result.current.index).toBe(1);
  expect(audio.start).toHaveBeenCalledTimes(starts);
});

test('starts the current clip while the next uncached clip is still preparing', async () => {
  const next = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback).mockImplementation(async request =>
    request.blockId === '1'
      ? next.promise
      : { block: blocks[Number(request.blockId)], voice: 'Kore', model: 'tts' }
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(audio.start).toHaveBeenCalledTimes(1));
  expect(result.current.loading).toBe(false);
  expect(result.current.playing).toBe(true);
  expect(audio.recordings.map(recording => recording.index)).toEqual([0]);
  await act(async () => next.resolve({ block: blocks[1], voice: 'Kore', model: 'tts' }));
  expect(audio.start).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '1')
  ).toHaveLength(1);
});

test('uses the audio clock unlocked in the opening gesture', async () => {
  const audioSessionRef = { current: audio as unknown as LessonPlaybackAudio };
  const { result } = renderHook(() => useLessonPlayback({ ...target, audioSessionRef }));
  await act(async () => result.current.play());
  expect(audio.unlock).toHaveBeenCalled();
  expect(audio.paused).toBe(false);
});

test('adopts completed alignment during playback without decoding or restarting the recording', async () => {
  const stop = vi.fn();
  vi.mocked(subscribeToPlaybackChanges).mockReturnValueOnce(stop);
  const { result, unmount } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  const downloads = vi.mocked(downloadProjectAssetBytes).mock.calls.length;
  const starts = audio.start.mock.calls.length;
  const alignment = { status: 'aligned' as const, onsets: [0.1, 0.6] };
  vi.mocked(getLessonPlayback).mockResolvedValueOnce({
    lessonKey: 'a'.repeat(64),
    blocks: blocks.map(block => ({
      ...block,
      audio: block.audio.map(audio => ({ ...audio, wordAlignment: alignment })),
    })),
  });
  const notify = vi.mocked(subscribeToPlaybackChanges).mock.calls.at(-1)?.[1];
  if (!notify) throw new Error('Playback revision listener is required');
  await act(async () => {
    notify();
  });
  expect(result.current.recording?.wordAlignment).toEqual(alignment);
  expect(downloadProjectAssetBytes).toHaveBeenCalledTimes(downloads);
  expect(audio.start).toHaveBeenCalledTimes(starts);
  expect(result.current.playing).toBe(true);
  unmount();
  expect(stop).toHaveBeenCalledOnce();
});

test.each([
  'pause',
  'unmount',
  'seek',
  'voice',
])('%s aborts obsolete preparation and prevents late audio', async action => {
  const pending = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback).mockImplementationOnce((_, signal) =>
    pendingUntilAbort(pending.promise, signal)
  );
  const { result, rerender, unmount } = renderHook(
    ({ voice }) => useLessonPlayback({ ...target, voice }),
    { initialProps: { voice: 'Kore' } }
  );
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalled());
  const signal = vi.mocked(prepareLessonPlayback).mock.calls[0][1];
  if (action === 'unmount') unmount();
  else if (action === 'pause') act(() => result.current.pause());
  else if (action === 'seek') act(() => result.current.seek(25));
  else rerender({ voice: 'Zephyr' });
  expect(signal).toBeUndefined();
  await act(async () => pending.resolve({ block: blocks[0], voice: 'Kore', model: 'tts' }));
  if (action === 'seek') {
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.index).toBe(2);
    expect(activeAudio().position.time).toBe(5);
  } else if (action === 'pause') {
    expect(result.current.playing).toBe(false);
    expect(audio.paused).toBe(true);
  }
  if (action !== 'unmount') expect(result.current.failed).toBe(false);
});

test('seek cancels an obsolete asset download without waiting for its bytes', async () => {
  const pending = deferred<Uint8Array>();
  vi.mocked(downloadProjectAssetBytes).mockImplementationOnce((_, __, signal) =>
    pendingUntilAbort(pending.promise, signal)
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(downloadProjectAssetBytes).toHaveBeenCalled());
  const signal = vi.mocked(downloadProjectAssetBytes).mock.calls[0][2];
  act(() => result.current.seek(25));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(signal?.aborted).toBe(true);
  expect(result.current.index).toBe(2);
  expect(activeAudio().position.time).toBe(5);
  await act(async () => pending.resolve(new Uint8Array([1])));
  expect(result.current.index).toBe(2);
});

test('a pause cancels polling and a late completion cannot restart preparation', async () => {
  const pending = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockResolvedValueOnce({
    runId: 'run',
    blockId: '0',
    voice: 'Kore',
  });
  vi.mocked(waitForLessonPlayback).mockImplementationOnce((_, __, signal) =>
    pendingUntilAbort(pending.promise, signal)
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(waitForLessonPlayback).toHaveBeenCalled());
  const signal = vi.mocked(waitForLessonPlayback).mock.calls[0][2];
  act(() => result.current.pause());
  const count = vi.mocked(prepareLessonPlayback).mock.calls.length;
  await act(async () => pending.resolve(undefined));
  expect(signal.aborted).toBe(true);
  expect(prepareLessonPlayback).toHaveBeenCalledTimes(count);
  expect(result.current.failed).toBe(false);
});

test('waits for a durable commit before requesting the same block again', async () => {
  const pending = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockResolvedValueOnce({
    runId: 'run',
    blockId: '0',
    voice: 'Kore',
  });
  vi.mocked(waitForLessonPlayback).mockImplementationOnce((_, __, signal) =>
    pendingUntilAbort(pending.promise, signal)
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(waitForLessonPlayback).toHaveBeenCalled());
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
  ).toHaveLength(1);
  await act(async () => pending.resolve(undefined));
  await waitFor(() => expect(result.current.playing).toBe(true));
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
  ).toHaveLength(2);
  expect(getLessonPlayback).toHaveBeenCalledOnce();
});

test('refreshes a stale initial lesson key before retrying its recording', async () => {
  vi.mocked(getLessonPlayback)
    .mockResolvedValueOnce({ lessonKey: 'old', blocks })
    .mockResolvedValue({ lessonKey: 'new', blocks });
  vi.mocked(prepareLessonPlayback).mockRejectedValueOnce(new LessonPlaybackRequestError(409));
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  expect(
    vi
      .mocked(prepareLessonPlayback)
      .mock.calls.some(([request]) => request.blockId === '0' && request.lessonKey === 'new')
  ).toBe(true);
  expect(result.current.failed).toBe(false);
});

test('a regenerated lesson while listening pauses and resets the old recording', async () => {
  audio.decode.mockResolvedValue({ duration: 40 } as AudioBuffer);
  const long = blocks.map(block => ({
    ...block,
    audio: [{ ...block.audio[0], durationSeconds: 40 }],
  }));
  vi.mocked(getLessonPlayback).mockResolvedValue({ lessonKey: 'old', blocks: long });
  vi.mocked(prepareLessonPlayback).mockImplementation(async request => ({
    block: long[Number(request.blockId)],
    voice: 'Kore',
    model: 'tts',
  }));
  const { result } = renderHook(() => useLessonPlayback({ ...target, initialBlocks: long }));
  await act(async () => result.current.play());
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalledTimes(2));
  vi.mocked(getLessonPlayback).mockResolvedValue({ lessonKey: 'new', blocks: [long[0]] });
  vi.mocked(prepareLessonPlayback).mockRejectedValueOnce(new LessonPlaybackRequestError(409));
  act(() => audio.moveTo(1));
  await waitFor(() => expect(result.current.blocks).toHaveLength(1));
  expect(result.current.playing).toBe(false);
  expect(result.current.time).toBe(0);
  expect(result.current.lessonKey).toBe('new');
});

test.each([
  'first play',
  'resume',
])('an intentional pause during pending %s is not an error', async mode => {
  const pending = deferred<void>();
  const { result } = renderHook(() => useLessonPlayback(target));
  if (mode === 'resume') {
    await act(async () => result.current.play());
    act(() => result.current.pause());
  }
  audio.start.mockReturnValueOnce(pending.promise);
  const starts = audio.start.mock.calls.length;
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(audio.start.mock.calls.length).toBeGreaterThan(starts));
  act(() => result.current.pause());
  await act(async () => pending.reject(new DOMException('Interrupted', 'AbortError')));
  expect(result.current.failed).toBe(false);
  expect(result.current.playing).toBe(false);
});
test('a genuine media failure remains visible and retry retains its position', async () => {
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  audio.position.time = 7;
  act(() => audio.onError?.(new Error('decode failure')));
  expect(result.current.failed).toBe(true);
  await act(async () => result.current.play());
  expect(result.current.failed).toBe(false);
  expect(audio.position.time).toBe(7);
});

test.each([
  'play',
  'resume',
  'seek',
  'voice',
])('a start rejection during %s settles loading and permits retry', async entry => {
  const { result, rerender } = renderHook(({ voice }) => useLessonPlayback({ ...target, voice }), {
    initialProps: { voice: 'Kore' },
  });
  if (entry !== 'play') await act(async () => result.current.play());
  if (entry === 'resume') act(() => result.current.pause());
  audio.start.mockRejectedValueOnce(new Error('Worklet initialization failed'));
  await act(async () => {
    if (entry === 'seek') result.current.seek(2);
    else if (entry === 'voice') rerender({ voice: 'Puck' });
    else await result.current.play();
  });
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.loading).toBe(false);
  expect(result.current.playing).toBe(false);
  await act(async () => result.current.play());
  expect(result.current.failed).toBe(false);
  expect(result.current.playing).toBe(true);
});

test('seek within a recording cancels and refills prefetch without redownloading audio', async () => {
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  const signal = vi.mocked(downloadProjectAssetBytes).mock.calls[0][2];
  await act(async () => result.current.seek(4));
  expect(signal?.aborted).toBe(true);
  expect(activeAudio().position.time).toBe(4);
  expect(result.current.readPosition()).toEqual({ index: 0, time: 4, duration: 10 });
  expect(downloadProjectAssetBytes).toHaveBeenCalledTimes(3);
});

test('uses resolved voice and model for both the recording and the timeline', async () => {
  audio.decode.mockResolvedValue({ duration: 20 } as AudioBuffer);
  const canonical = blocks.map(block => ({
    ...block,
    audio: [
      { ...block.audio[0], voice: 'Ara', model: 'old', durationSeconds: 1 },
      {
        ...block.audio[0],
        voice: 'Ara',
        model: 'grok',
        durationSeconds: 20,
        asset: { ...block.audio[0].asset, id: 'b'.repeat(64) },
      },
    ],
  }));
  vi.mocked(getLessonPlayback).mockResolvedValue({ lessonKey: 'a'.repeat(64), blocks: canonical });
  vi.mocked(prepareLessonPlayback).mockImplementation(async request => ({
    block: canonical[Number(request.blockId)],
    voice: 'Ara',
    model: 'grok',
  }));
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  expect(downloadProjectAssetBytes).toHaveBeenCalledWith(
    target.projectId,
    canonical[0].audio[1].asset,
    expect.any(AbortSignal)
  );
  expect(result.current.duration).toBe(20);
  expect(result.current.total).toBe(60);
});

test('voice changes preserve the relative position when the duration changes', async () => {
  vi.mocked(prepareLessonPlayback).mockImplementation(async request => ({
    block: {
      ...blocks[Number(request.blockId)],
      audio: [
        {
          ...blocks[0].audio[0],
          voice: request.voice,
          durationSeconds: request.voice === 'Zephyr' ? 20 : 10,
        },
      ],
    },
    voice: request.voice,
    model: 'tts',
  }));
  const { result, rerender } = renderHook(({ voice }) => useLessonPlayback({ ...target, voice }), {
    initialProps: { voice: 'Kore' },
  });
  await act(async () => result.current.play());
  activeAudio().position.time = 5;
  audio.decode.mockResolvedValue({ duration: 20 } as AudioBuffer);
  rerender({ voice: 'Zephyr' });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(activeAudio().position.time).toBe(10);
  expect(result.current.time).toBe(10);
});

test('pending voice audio keeps the requested anchor through pause and retry', async () => {
  const { result, rerender } = renderHook(({ voice }) => useLessonPlayback({ ...target, voice }), {
    initialProps: { voice: 'Kore' },
  });
  await act(async () => result.current.play());
  activeAudio().position.time = 8;
  const pending = deferred<Uint8Array>();
  vi.mocked(downloadProjectAssetBytes).mockImplementationOnce((_, __, signal) =>
    pendingUntilAbort(pending.promise, signal)
  );
  rerender({ voice: 'Zephyr' });
  await waitFor(() => expect(result.current.loading).toBe(true));
  expect(result.current.readPosition()).toEqual({ index: 0, time: 0.8, duration: 1 });
  act(() => result.current.pause());
  await act(async () => pending.resolve(new Uint8Array([1])));
  expect(result.current.readPosition()).toEqual({ index: 0, time: 0.8, duration: 1 });
  await act(async () => result.current.play());
  expect(activeAudio().position.time).toBe(8);
});

test('end of lesson resets the displayed block and a later seek remains usable', async () => {
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  act(() => result.current.seek(25));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.index).toBe(2);
  act(() => audio.onEnded?.());
  expect(result.current.index).toBe(0);
  expect(result.current.time).toBe(0);
  act(() => result.current.seek(2));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => result.current.play());
  expect(activeAudio().position.time).toBe(2);
});

test('unmount releases the audio clock', async () => {
  const { result, unmount } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  unmount();
  await Promise.resolve();
  expect(audio.close).toHaveBeenCalled();
  expect(audio.paused).toBe(true);
});

test('exposes the audio clock to a stage on its first effect', () => {
  const observed = vi.fn();
  function Stage({ readTime }: { readTime: () => number }) {
    useEffect(() => {
      observed(readTime());
    }, [readTime]);
    return null;
  }
  function Player() {
    const playback = useLessonPlayback(target);
    return <Stage readTime={playback.readTime} />;
  }
  render(<Player />);
  expect(observed).toHaveBeenCalledWith(0);
});

test.each([
  true,
  false,
])('pause cancels owned preparation but leaves joined work with its owner (created: %s)', async created => {
  const pending = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockResolvedValueOnce({
    runId: 'run',
    blockId: '0',
    voice: 'Kore',
    created,
  });
  vi.mocked(waitForLessonPlayback).mockImplementationOnce((_, __, signal) =>
    pendingUntilAbort(pending.promise, signal)
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(waitForLessonPlayback).toHaveBeenCalled());
  act(() => result.current.pause());
  if (created)
    expect(cancelLessonPlaybackPreparation).toHaveBeenCalledWith('run', target.projectId);
  else expect(cancelLessonPlaybackPreparation).not.toHaveBeenCalled();
  await act(async () => pending.resolve(undefined));
});

test('time updates do not retry a failed paid prefetch automatically', async () => {
  audio.decode.mockResolvedValue({ duration: 40 } as AudioBuffer);
  const long = blocks.map(block => ({
    ...block,
    audio: [{ ...block.audio[0], durationSeconds: 40 }],
  }));
  vi.mocked(getLessonPlayback).mockResolvedValue({ lessonKey: 'a'.repeat(64), blocks: long });
  vi.mocked(prepareLessonPlayback).mockImplementation(async request => {
    if (request.blockId === '1') throw new Error('Provider unavailable');
    return { block: long[Number(request.blockId)], voice: 'Kore', model: 'tts' };
  });
  const { result } = renderHook(() => useLessonPlayback({ ...target, initialBlocks: long }));
  await act(async () => result.current.play());
  await waitFor(() => expect(result.current.failed).toBe(true));
  await act(async () => {
    for (let index = 0; index < 5; index++) audio.moveTo(0, index);
  });
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '1')
  ).toHaveLength(1);
  expect(result.current.playing).toBe(true);
});

test('a lesson replaced during the opening buffer plays only the new lesson recording', async () => {
  const replacement = blocks.map(block => ({
    ...block,
    speech: 'New passage',
    audio: [{ ...block.audio[0], asset: { ...block.audio[0].asset, id: 'b'.repeat(64) } }],
  }));
  vi.mocked(getLessonPlayback)
    .mockResolvedValueOnce({ lessonKey: 'old', blocks })
    .mockResolvedValue({ lessonKey: 'new', blocks: replacement });
  let changed = false;
  vi.mocked(prepareLessonPlayback).mockImplementation(async request => {
    if (request.blockId === '1' && !changed) {
      changed = true;
      throw new LessonPlaybackRequestError(409);
    }
    return {
      block: (request.lessonKey === 'new' ? replacement : blocks)[Number(request.blockId)],
      voice: 'Kore',
      model: 'tts',
    };
  });
  vi.mocked(downloadProjectAssetBytes).mockImplementation(
    async (_, asset) => new Uint8Array([asset.id.charCodeAt(0)])
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  expect(result.current.blocks[0].speech).toBe('New passage');
  const buffer = audio.recordings[0].buffer as AudioBuffer & { bytes: Uint8Array };
  expect(buffer.bytes[0]).toBe('b'.charCodeAt(0));
});

test.each([
  'resume',
  'voice',
  'regenerated lesson',
])('%s waits for cancellation of the block shared by all its voices', async action => {
  const preparation = deferred<void>(),
    cancellation = deferred<void>();
  if (action === 'regenerated lesson') {
    vi.mocked(getLessonPlayback)
      .mockResolvedValueOnce({ lessonKey: 'old', blocks })
      .mockResolvedValue({ lessonKey: 'new', blocks });
    vi.mocked(prepareLessonPlayback).mockRejectedValueOnce(new LessonPlaybackRequestError(409));
  }
  vi.mocked(prepareLessonPlayback).mockResolvedValueOnce({
    runId: 'owned',
    blockId: '0',
    voice: 'Kore',
    created: true,
  });
  vi.mocked(waitForLessonPlayback).mockImplementationOnce((_, __, signal) =>
    pendingUntilAbort(preparation.promise, signal)
  );
  vi.mocked(cancelLessonPlaybackPreparation).mockReturnValueOnce(cancellation.promise);
  const { result, rerender } = renderHook(({ voice }) => useLessonPlayback({ ...target, voice }), {
    initialProps: { voice: 'Kore' },
  });
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(waitForLessonPlayback).toHaveBeenCalled());
  if (action !== 'voice') {
    act(() => result.current.pause());
    act(() => {
      void result.current.play();
    });
  } else rerender({ voice: 'Zephyr' });
  await act(async () => {});
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
  ).toHaveLength(action === 'regenerated lesson' ? 2 : 1);
  await act(async () => cancellation.resolve(undefined));
  await waitFor(() => expect(result.current.playing).toBe(true));
  expect(result.current.failed).toBe(false);
  preparation.resolve(undefined);
});

test('a seek releases queue slots waiting on cancellation of unrelated blocks', async () => {
  const cancelled = deferred<void>();
  vi.mocked(cancelLessonPlaybackPreparation).mockReturnValue(cancelled.promise);
  vi.mocked(prepareLessonPlayback).mockImplementation(async request =>
    request.blockId === '2'
      ? { block: blocks[2], voice: 'Kore', model: 'tts' }
      : { runId: request.blockId, blockId: request.blockId, voice: 'Kore', created: true }
  );
  vi.mocked(waitForLessonPlayback).mockImplementation((_, __, signal) =>
    pendingUntilAbort(new Promise<void>(() => {}), signal)
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(waitForLessonPlayback).toHaveBeenCalledTimes(2));
  act(() => result.current.pause());
  act(() => {
    void result.current.play();
  });
  await act(async () => {});
  act(() => result.current.seek(25));
  await waitFor(() => expect(result.current.playing).toBe(true));
  expect(result.current.index).toBe(2);
  expect(activeAudio().position.time).toBe(5);
  await act(async () => cancelled.resolve(undefined));
});

test.each([
  true,
  false,
])('pause tracks creation responses still in transit (owned: %s)', async created => {
  const response = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  const cancellation = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockImplementationOnce((_, signal) =>
    pendingUntilAbort(response.promise, signal)
  );
  vi.mocked(cancelLessonPlaybackPreparation).mockReturnValueOnce(cancellation.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalled());
  act(() => result.current.pause());
  act(() => {
    void result.current.play();
  });
  await act(async () => {});
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
  ).toHaveLength(1);
  await act(async () =>
    response.resolve({ runId: 'in-transit', blockId: '0', voice: 'Kore', created })
  );
  if (created) {
    await waitFor(() =>
      expect(cancelLessonPlaybackPreparation).toHaveBeenCalledWith('in-transit', target.projectId)
    );
    expect(
      vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
    ).toHaveLength(1);
  } else expect(cancelLessonPlaybackPreparation).not.toHaveBeenCalled();
  await act(async () => cancellation.resolve(undefined));
  await waitFor(() => expect(result.current.playing).toBe(true));
  expect(result.current.failed).toBe(false);
});

test('changing voice while the first listen is paused prepares only the selected passage', async () => {
  const pending = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback).mockReturnValueOnce(pending.promise);
  const { result, rerender } = renderHook(({ voice }) => useLessonPlayback({ ...target, voice }), {
    initialProps: { voice: 'Kore' },
  });
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalled());
  act(() => result.current.pause());
  await act(async () => pending.resolve({ block: blocks[0], voice: 'Kore', model: 'tts' }));
  rerender({ voice: 'Zephyr' });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(
    vi
      .mocked(prepareLessonPlayback)
      .mock.calls.filter(([request]) => request.voice === 'Zephyr')
      .map(([request]) => request.blockId)
  ).toEqual(['0']);
  expect(result.current.playing).toBe(false);
});

test.each([
  'seek',
  'resume',
])('%s near the end starts without waiting for upcoming audio', async action => {
  audio.decode.mockResolvedValue({ duration: 40 } as AudioBuffer);
  const long = blocks.map((block, index) => ({
    ...block,
    audio: [{ ...block.audio[0], durationSeconds: index === 0 ? 40 : 10 }],
  }));
  const pending = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(getLessonPlayback).mockResolvedValue({ lessonKey: 'a'.repeat(64), blocks: long });
  vi.mocked(prepareLessonPlayback).mockImplementation(async request =>
    request.blockId === '1'
      ? pending.promise
      : { block: long[Number(request.blockId)], voice: 'Kore', model: 'tts' }
  );
  const { result } = renderHook(() => useLessonPlayback({ ...target, initialBlocks: long }));
  await act(async () => result.current.play());
  if (action === 'resume') {
    audio.position.time = 39;
    act(() => result.current.pause());
    act(() => {
      void result.current.play();
    });
  } else act(() => result.current.seek(39));
  await act(async () => {});
  expect(audio.paused).toBe(false);
  expect(result.current.loading).toBe(false);
  await act(async () => pending.resolve({ block: long[1], voice: 'Kore', model: 'tts' }));
  await waitFor(() => expect(audio.paused).toBe(false));
  expect(audio.position.time).toBe(39);
  expect(result.current.failed).toBe(false);
});

test('a ready next passage reaches the stream while a farther passage is pending', async () => {
  const long = blocks.map((block, index) => ({
    ...block,
    audio: [{ ...block.audio[0], durationSeconds: index === 0 ? 40 : 10 }],
  }));
  const pending = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  audio.decode.mockResolvedValue({ duration: 40 } as AudioBuffer);
  vi.mocked(getLessonPlayback).mockResolvedValue({ lessonKey: 'a'.repeat(64), blocks: long });
  vi.mocked(prepareLessonPlayback).mockImplementation(async request =>
    request.blockId === '2'
      ? pending.promise
      : { block: long[Number(request.blockId)], voice: 'Kore', model: 'tts' }
  );
  const { result } = renderHook(() => useLessonPlayback({ ...target, initialBlocks: long }));
  await act(async () => result.current.play());
  await waitFor(() =>
    expect(
      audio.append.mock.calls.some(
        ([recordings]) => recordings.map(recording => recording.index).join(',') === '0,1'
      )
    ).toBe(true)
  );
  expect(result.current.playing).toBe(true);
  await act(async () => pending.resolve({ block: long[2], voice: 'Kore', model: 'tts' }));
});

test('speed changes keep playing while the horizon is preparing', async () => {
  const long = blocks.map(block => ({
    ...block,
    audio: [{ ...block.audio[0], durationSeconds: 20 }],
  }));
  const pending = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  audio.decode.mockResolvedValue({ duration: 20 } as AudioBuffer);
  vi.mocked(getLessonPlayback).mockResolvedValue({ lessonKey: 'a'.repeat(64), blocks: long });
  vi.mocked(prepareLessonPlayback).mockImplementation(async request =>
    request.blockId === '2'
      ? pending.promise
      : { block: long[Number(request.blockId)], voice: 'Kore', model: 'tts' }
  );
  const { result, rerender } = renderHook(
    ({ speed }) => useLessonPlayback({ ...target, initialBlocks: long, speed }),
    { initialProps: { speed: 2 } }
  );
  act(() => {
    void result.current.play();
  });
  await waitFor(() =>
    expect(
      vi.mocked(prepareLessonPlayback).mock.calls.some(([request]) => request.blockId === '2')
    ).toBe(true)
  );
  expect(result.current.playing).toBe(true);
  const starts = audio.start.mock.calls.length;
  rerender({ speed: 1 });
  expect(audio.start).toHaveBeenCalledTimes(starts);
  await waitFor(() => expect(result.current.playing).toBe(true));
  await act(async () => pending.resolve({ block: long[2], voice: 'Kore', model: 'tts' }));
});

test('replacing a player leaves its supplied audio session with the shell owner', async () => {
  const audioSessionRef = { current: audio as unknown as LessonPlaybackAudio };
  const first = renderHook(() => useLessonPlayback({ ...target, audioSessionRef }));
  await act(async () => first.result.current.play());
  first.unmount();
  renderHook(() => useLessonPlayback({ ...target, audioSessionRef }));
  await Promise.resolve();
  expect(audio.close).not.toHaveBeenCalled();
});

test.each([
  'resume',
  'voice',
])('%s uses the audio-clock passage at a boundary before its notification', async action => {
  const { result, rerender } = renderHook(({ voice }) => useLessonPlayback({ ...target, voice }), {
    initialProps: { voice: 'Kore' },
  });
  await act(async () => result.current.play());
  audio.position = { index: 1, time: 4, duration: 10 };
  if (action === 'resume') {
    act(() => result.current.pause());
    await act(async () => result.current.play());
  } else {
    rerender({ voice: 'Zephyr' });
    await waitFor(() => expect(result.current.loading).toBe(false));
  }
  expect(result.current.index).toBe(1);
  expect(result.current.time).toBe(4);
});

test('a decoded result cannot restore a lesson already replaced during decoding', async () => {
  const oldBlocks = blocks.map(block => ({
    ...block,
    audio: [{ ...block.audio[0], durationSeconds: 40 }],
  }));
  const replacement = oldBlocks.map(block => ({ ...block, speech: 'Replacement passage' }));
  const decoding = deferred<void>(),
    decoded = deferred<AudioBuffer>();
  audio.decode
    .mockImplementationOnce(() => {
      decoding.resolve(undefined);
      return decoded.promise;
    })
    .mockResolvedValue({ duration: 40, tag: 'new' } as unknown as AudioBuffer);
  vi.mocked(getLessonPlayback)
    .mockResolvedValueOnce({ lessonKey: 'old', blocks: oldBlocks })
    .mockResolvedValue({ lessonKey: 'new', blocks: replacement });
  vi.mocked(prepareLessonPlayback).mockImplementation(async request => {
    if (request.lessonKey === 'old' && request.blockId === '1') {
      await decoding.promise;
      throw new LessonPlaybackRequestError(409);
    }
    return {
      block: (request.lessonKey === 'old' ? oldBlocks : replacement)[Number(request.blockId)],
      voice: 'Kore',
      model: 'tts',
    };
  });
  const { result } = renderHook(() => useLessonPlayback({ ...target, initialBlocks: oldBlocks }));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(getLessonPlayback).toHaveBeenCalledTimes(2));
  await act(async () => decoded.resolve({ duration: 40, tag: 'old' } as unknown as AudioBuffer));
  await waitFor(() => expect(result.current.playing).toBe(true));
  const buffer = audio.recordings[0].buffer as AudioBuffer & { tag: string };
  expect(buffer.tag).toBe('new');
  expect(result.current.blocks[0].speech).toBe('Replacement passage');
});

test('reopening a player waits for the previous instance to finish owned cancellation', async () => {
  const creation = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  const cancellation = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockReturnValueOnce(creation.promise);
  vi.mocked(cancelLessonPlaybackPreparation).mockReturnValueOnce(cancellation.promise);
  const first = renderHook(() => useLessonPlayback(target));
  act(() => {
    void first.result.current.play();
  });
  await waitFor(() =>
    expect(
      vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
    ).toHaveLength(1)
  );
  first.unmount();
  const second = renderHook(() => useLessonPlayback(target));
  act(() => {
    void second.result.current.play();
  });
  try {
    await act(async () => {});
    expect(
      vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
    ).toHaveLength(1);
    await act(async () =>
      creation.resolve({ runId: 'closing', blockId: '0', voice: 'Kore', created: true })
    );
    expect(cancelLessonPlaybackPreparation).toHaveBeenCalledWith('closing', target.projectId);
    expect(
      vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
    ).toHaveLength(1);
  } finally {
    await act(async () => {
      creation.resolve({ runId: 'closing', blockId: '0', voice: 'Kore', created: true });
      cancellation.resolve(undefined);
    });
  }
  await waitFor(() => expect(second.result.current.playing).toBe(true));
});

test('an underrun waits for the existing preparation and resumes at the next clip', async () => {
  const next = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback).mockImplementation(async request =>
    request.blockId === '1'
      ? next.promise
      : { block: blocks[Number(request.blockId)], voice: 'Kore', model: 'tts' }
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  audio.position.time = 10;
  act(() => {
    audio.pause();
    audio.onEnded?.();
  });
  expect(result.current.loading).toBe(true);
  expect(result.current.index).toBe(1);
  expect(audio.paused).toBe(true);
  await act(async () => next.resolve({ block: blocks[1], voice: 'Kore', model: 'tts' }));
  expect(result.current.loading).toBe(false);
  expect(result.current.playing).toBe(true);
  expect(audio.position).toEqual({ index: 1, time: 0, duration: 10 });
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '1')
  ).toHaveLength(1);
  expect(audio.start).toHaveBeenCalledTimes(2);
});

test('an ending start cannot hide loading for its pending successor', async () => {
  const next = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  const scheduled = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockImplementation(async request =>
    request.blockId === '1'
      ? next.promise
      : { block: blocks[Number(request.blockId)], voice: 'Kore', model: 'tts' }
  );
  const start = audio.start.getMockImplementation();
  if (!start) throw new Error('Playback test start must be installed');
  audio.start.mockImplementationOnce(async (...args) => {
    await start(...args);
    await scheduled.promise;
    audio.position.time = 10;
    audio.pause();
    audio.onEnded?.();
  });
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(audio.start).toHaveBeenCalledTimes(1));
  await act(async () => scheduled.resolve());
  expect(result.current.index).toBe(1);
  expect(result.current.loading).toBe(true);
  await act(async () => next.resolve({ block: blocks[1], voice: 'Kore', model: 'tts' }));
  expect(result.current.loading).toBe(false);
  expect(result.current.playing).toBe(true);
  expect(audio.position).toEqual({ index: 1, time: 0, duration: 10 });
});

test('retains an alignment notification received while the recording is decoding', async () => {
  const decoded = deferred<AudioBuffer>();
  audio.decode.mockImplementationOnce(() => decoded.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  let playing: Promise<void>;
  act(() => {
    playing = result.current.play();
  });
  await waitFor(() => expect(audio.decode).toHaveBeenCalled());
  const alignment = { status: 'aligned' as const, onsets: [0.1, 0.6] };
  vi.mocked(getLessonPlayback).mockResolvedValueOnce({
    lessonKey: 'a'.repeat(64),
    blocks: blocks.map(block => ({
      ...block,
      audio: block.audio.map(recording => ({ ...recording, wordAlignment: alignment })),
    })),
  });
  const notify = vi.mocked(subscribeToPlaybackChanges).mock.calls.at(-1)?.[1];
  if (!notify) throw new Error('Playback revision listener is required');
  await act(async () => {
    notify();
  });
  await act(async () => {
    decoded.resolve({ duration: 10 } as AudioBuffer);
    await playing;
  });
  expect(result.current.recording?.wordAlignment).toEqual(alignment);
  expect(audio.start).toHaveBeenCalledOnce();
});

test('keeps narration paused until prepared visuals are ready', async () => {
  vi.mocked(prepareLessonPlayback).mockImplementation(async request => ({
    block: sceneBlocks[Number(request.blockId)],
    voice: 'Kore',
    model: 'tts',
  }));
  const visuals = deferred<void>();
  const prepareVisuals = vi.fn(
    (_blocks: readonly LessonPlaybackBlock[], _signal: AbortSignal) => visuals.promise
  );
  const { result } = renderHook(() => useLessonPlayback({ ...target, prepareVisuals }));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareVisuals).toHaveBeenCalled());
  expect(prepareVisuals.mock.calls[0][0][0].prepared?.scene).toEqual(sceneBlocks[0].prepared.scene);
  expect(audio.start).not.toHaveBeenCalled();
  expect(result.current.loading).toBe(true);
  await act(async () => {
    visuals.resolve();
  });
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(result.current.playing).toBe(true);
});

test('keeps a newly generated future scene out of the audio buffer until its visuals are ready', async () => {
  const future = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  const visual = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockImplementation(async request =>
    request.blockId === '1'
      ? future.promise
      : { block: blocks[Number(request.blockId)], voice: 'Kore', model: 'tts' }
  );
  const prepareVisuals = vi.fn(async (prepared: readonly LessonPlaybackBlock[]) => {
    if (prepared.some(block => block.id === '1' && block.prepared?.scene)) await visual.promise;
  });
  const { result } = renderHook(() => useLessonPlayback({ ...target, prepareVisuals }));
  await act(async () => result.current.play());
  expect(audio.start).toHaveBeenCalledOnce();
  expect(audio.recordings.map(recording => recording.index)).toEqual([0]);
  await act(async () => {
    future.resolve({ block: sceneBlocks[1], voice: 'Kore', model: 'tts' });
  });
  expect(
    prepareVisuals.mock.calls.some(([prepared]) =>
      prepared.some(block => block.id === '1' && block.prepared?.scene)
    )
  ).toBe(true);
  expect(
    audio.append.mock.calls.every(([recordings]) =>
      recordings.every(recording => recording.index !== 1)
    )
  ).toBe(true);
  await act(async () => visual.resolve());
  await waitFor(() =>
    expect(
      audio.append.mock.calls.some(([recordings]) =>
        recordings.some(recording => recording.index === 1)
      )
    ).toBe(true)
  );
  expect(audio.start).toHaveBeenCalledOnce();
});

test('a pause during visual preparation prevents a late audio start and permits resuming', async () => {
  const visuals = deferred<void>();
  const prepareVisuals = vi.fn(
    (_blocks: readonly LessonPlaybackBlock[], _signal: AbortSignal) => visuals.promise
  );
  const { result } = renderHook(() => useLessonPlayback({ ...target, prepareVisuals }));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareVisuals).toHaveBeenCalled());
  const signal = prepareVisuals.mock.calls[0][1];
  act(() => result.current.pause());
  expect(signal.aborted).toBe(true);
  await act(async () => {
    visuals.resolve();
  });
  expect(audio.start).not.toHaveBeenCalled();
  expect(result.current.loading).toBe(false);
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(result.current.playing).toBe(true);
});

test('plays the authoritative saved recording when a visual-only upgrade fails', async () => {
  const saved = { block: blocks[0], voice: 'Kore', model: 'tts' };
  vi.mocked(prepareLessonPlayback).mockResolvedValueOnce({
    runId: 'visual-upgrade',
    blockId: '0',
    voice: 'Kore',
    created: true,
    recorded: saved,
  });
  vi.mocked(waitForLessonPlayback).mockRejectedValueOnce(new Error('Visual provider unavailable'));
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(result.current.playing).toBe(true));
  expect(activeAudio().recordings[0].index).toBe(0);
  expect(result.current.failed).toBe(false);
  expect(downloadProjectAssetBytes).toHaveBeenCalledWith(
    target.projectId,
    blocks[0].audio[0].asset,
    expect.any(AbortSignal)
  );
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
  ).toHaveLength(1);
});

test('cancels a visual-only upgrade without starting its saved recording', async () => {
  const pending = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockResolvedValueOnce({
    runId: 'cancelled-visual-upgrade',
    blockId: '0',
    voice: 'Kore',
    created: true,
    recorded: { block: blocks[0], voice: 'Kore', model: 'tts' },
  });
  vi.mocked(waitForLessonPlayback).mockImplementationOnce((_, __, signal) =>
    pendingUntilAbort(pending.promise, signal)
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(waitForLessonPlayback).toHaveBeenCalled());
  act(() => result.current.pause());
  await act(async () => pending.reject(new Error('Cancelled visual preparation')));
  expect(audio.start).not.toHaveBeenCalled();
  expect(result.current.playing).toBe(false);
  expect(result.current.failed).toBe(false);
});
test('keeps a preparation failure visible without an authoritative recording, then retries', async () => {
  vi.mocked(prepareLessonPlayback).mockResolvedValueOnce({
    runId: 'new-recording',
    blockId: '0',
    voice: 'Kore',
    created: true,
  });
  vi.mocked(waitForLessonPlayback).mockRejectedValueOnce(
    new Error('Recording preparation unavailable')
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.playing).toBe(false);
  expect(audio.start).not.toHaveBeenCalled();
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(result.current.playing).toBe(true));
  expect(result.current.failed).toBe(false);
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
  ).toHaveLength(2);
});
