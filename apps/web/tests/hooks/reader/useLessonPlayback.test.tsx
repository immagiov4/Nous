// @vitest-environment jsdom

import { segmentLessonPlayback } from '@shared/lessonPlayback';
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
  waitForLessonPlayback,
} from '../../../services/openrouter/lessonPlaybackClient.ts';
import { downloadProjectAssetBytes } from '../../../services/projects/projectAssetClient.ts';

vi.mock('../../../services/openrouter/lessonPlaybackClient.ts', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../../services/openrouter/lessonPlaybackClient.ts')
  >()),
  cancelLessonPlaybackPreparation: vi.fn().mockResolvedValue(undefined),
  getLessonPlayback: vi.fn(),
  prepareLessonPlayback: vi.fn(),
  waitForLessonPlayback: vi.fn(),
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
let audio: HTMLAudioElement;

const audioElements: HTMLAudioElement[] = [];
function createAudioMock() {
  const element = document.createElement('audio');
  let paused = true;
  Object.defineProperty(element, 'paused', { get: () => paused });
  element.play = vi.fn(async () => {
    paused = false;
  });
  element.pause = vi.fn(() => {
    paused = true;
  });
  element.load = vi.fn();
  audioElements.push(element);
  return element;
}

beforeEach(() => {
  audioElements.length = 0;
  audio = createAudioMock();
  let allocated = false;
  vi.stubGlobal('Audio', function Audio() {
    if (allocated) return createAudioMock();
    allocated = true;
    return audio;
  });
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:audio-${crypto.randomUUID()}`);
      static revokeObjectURL = vi.fn();
    }
  );
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
  const active = audioElements.find(element => !element.paused);
  if (!active) throw new Error('Expected playing audio');
  return active;
}
function pendingUntilAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

test('buffers thirty seconds and preloads the next recording before starting', async () => {
  const first = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback).mockImplementationOnce((_, signal) =>
    pendingUntilAbort(first.promise, signal)
  );
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalled());
  expect(result.current.loading).toBe(true);
  expect(result.current.playing).toBe(false);
  await act(async () => first.resolve({ block: blocks[0], voice: 'Kore', model: 'tts' }));
  await waitFor(() => expect(result.current.playing).toBe(true));
  expect(vi.mocked(prepareLessonPlayback).mock.calls.map(([request]) => request.blockId)).toEqual([
    '0',
    '1',
    '2',
  ]);
  expect(downloadProjectAssetBytes).toHaveBeenCalledTimes(3);
  expect(audioElements[1].src).toMatch(/^blob:/);
  expect(audioElements[1].load).toHaveBeenCalled();
  const signals = vi.mocked(prepareLessonPlayback).mock.calls.map(([, signal]) => signal);
  act(() => activeAudio().dispatchEvent(new Event('ended')));
  await waitFor(() => expect(result.current.index).toBe(1));
  expect(activeAudio()).toBe(audioElements[1]);
  expect(signals.every(signal => !signal?.aborted)).toBe(true);
  expect(downloadProjectAssetBytes).toHaveBeenCalledTimes(3);
});

test('uses the element unlocked in the opening gesture and unlocks its standby', async () => {
  vi.stubGlobal('Audio', function Audio() {
    return createAudioMock();
  });
  const audioElementRef = { current: audio };
  const { result } = renderHook(() => useLessonPlayback({ ...target, audioElementRef }));
  await act(async () => result.current.play());
  expect(activeAudio()).toBe(audio);
  expect(audio.src).toMatch(/^blob:/);
  expect(audioElements[1].play).toHaveBeenCalled();
  expect(audioElements[1].paused).toBe(true);
});

test('an interrupted gesture unlock does not prevent narration', async () => {
  vi.mocked(audio.play).mockRejectedValueOnce(new DOMException('Interrupted', 'AbortError'));
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  expect(result.current.playing).toBe(true);
  expect(result.current.failed).toBe(false);
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
    expect(activeAudio().currentTime).toBe(5);
  } else if (action === 'pause') {
    expect(result.current.playing).toBe(false);
    expect(audioElements.every(element => element.paused)).toBe(true);
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
  expect(activeAudio().currentTime).toBe(5);
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
  act(() => activeAudio().dispatchEvent(new Event('ended')));
  await waitFor(() => expect(result.current.index).toBe(1));
  await waitFor(() => expect(result.current.blocks).toHaveLength(1));
  expect(result.current.playing).toBe(false);
  expect(result.current.time).toBe(0);
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
  const element = mode === 'resume' ? activeOrFirst() : audio;
  if (mode === 'first play') vi.mocked(element.play).mockResolvedValueOnce(undefined);
  vi.mocked(element.play).mockReturnValueOnce(pending.promise);
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(element.src).toMatch(/^blob:/));
  act(() => result.current.pause());
  await act(async () => pending.reject(new DOMException('Interrupted', 'AbortError')));
  expect(result.current.failed).toBe(false);
  expect(result.current.playing).toBe(false);
});
function activeOrFirst() {
  return audioElements.find(element => element.src.startsWith('blob:')) ?? audio;
}

test('a genuine media failure remains visible and retry retains its position', async () => {
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  const current = activeAudio();
  current.currentTime = 7;
  let mediaError: MediaError | null = { code: 3, message: 'decode failure' } as MediaError;
  Object.defineProperty(current, 'error', { get: () => mediaError });
  current.play = vi.fn(async () => {
    if (mediaError) throw new DOMException('Cannot play', 'NotSupportedError');
  });
  current.load = vi.fn(() => {
    mediaError = null;
  });
  act(() => current.dispatchEvent(new Event('error')));
  expect(result.current.failed).toBe(true);
  await act(async () => result.current.play());
  expect(result.current.failed).toBe(false);
  expect(current.load).toHaveBeenCalled();
  expect(current.currentTime).toBe(7);
});

test('seek within a recording cancels and refills prefetch without redownloading audio', async () => {
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  const signal = vi.mocked(downloadProjectAssetBytes).mock.calls[0][2];
  act(() => result.current.seek(4));
  expect(signal?.aborted).toBe(true);
  expect(activeAudio().currentTime).toBe(4);
  expect(result.current.readPosition()).toEqual({ time: 4, duration: 10 });
  expect(downloadProjectAssetBytes).toHaveBeenCalledTimes(3);
});

test('uses resolved voice and model for both the recording and the timeline', async () => {
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
    'project',
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
  activeAudio().currentTime = 5;
  rerender({ voice: 'Zephyr' });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(activeAudio().currentTime).toBe(10);
  expect(result.current.time).toBe(10);
});

test('pending voice audio keeps the requested anchor through pause and retry', async () => {
  const { result, rerender } = renderHook(({ voice }) => useLessonPlayback({ ...target, voice }), {
    initialProps: { voice: 'Kore' },
  });
  await act(async () => result.current.play());
  activeAudio().currentTime = 8;
  const pending = deferred<Uint8Array>();
  vi.mocked(downloadProjectAssetBytes).mockImplementationOnce((_, __, signal) =>
    pendingUntilAbort(pending.promise, signal)
  );
  rerender({ voice: 'Zephyr' });
  await waitFor(() => expect(result.current.loading).toBe(true));
  expect(result.current.readPosition()).toEqual({ time: 0.8, duration: 1 });
  act(() => result.current.pause());
  await act(async () => pending.resolve(new Uint8Array([1])));
  expect(result.current.readPosition()).toEqual({ time: 0.8, duration: 1 });
  await act(async () => result.current.play());
  expect(activeAudio().currentTime).toBe(8);
});

test('end of lesson resets the displayed block and a later seek remains usable', async () => {
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  act(() => result.current.seek(25));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.index).toBe(2);
  act(() => activeAudio().dispatchEvent(new Event('ended')));
  expect(result.current.index).toBe(0);
  expect(result.current.time).toBe(0);
  act(() => result.current.seek(2));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => result.current.play());
  expect(activeAudio().currentTime).toBe(2);
});

test('unmount releases both media elements and every cached recording URL', async () => {
  const { result, unmount } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  act(() => activeAudio().dispatchEvent(new Event('ended')));
  await waitFor(() => expect(result.current.index).toBe(1));
  unmount();
  expect(audioElements.every(element => element.paused && !element.hasAttribute('src'))).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
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
  if (created) expect(cancelLessonPlaybackPreparation).toHaveBeenCalledWith('run', 'project');
  else expect(cancelLessonPlaybackPreparation).not.toHaveBeenCalled();
  await act(async () => pending.resolve(undefined));
});

test('time updates do not retry a failed paid prefetch automatically', async () => {
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
    for (let index = 0; index < 5; index++) activeAudio().dispatchEvent(new Event('timeupdate'));
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
  const call = vi
    .mocked(URL.createObjectURL)
    .mock.results.findIndex(result => result.value === activeAudio().src);
  const blob = vi.mocked(URL.createObjectURL).mock.calls[call][0] as Blob;
  expect(new Uint8Array(await blob.arrayBuffer())[0]).toBe('b'.charCodeAt(0));
});

test.each([
  'resume',
  'voice',
])('%s waits for cancellation of the block shared by all its voices', async action => {
  const preparation = deferred<void>(),
    cancellation = deferred<void>();
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
  if (action === 'resume') {
    act(() => result.current.pause());
    act(() => {
      void result.current.play();
    });
  } else rerender({ voice: 'Zephyr' });
  await act(async () => {});
  expect(
    vi.mocked(prepareLessonPlayback).mock.calls.filter(([request]) => request.blockId === '0')
  ).toHaveLength(1);
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
  expect(activeAudio().currentTime).toBe(5);
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
      expect(cancelLessonPlaybackPreparation).toHaveBeenCalledWith('in-transit', 'project')
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
