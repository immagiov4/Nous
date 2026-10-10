// @vitest-environment jsdom

import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { LessonPlaybackResponseSchema } from '@shared/lessonPlaybackSchema';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useLessonPlayback } from '../../../hooks/reader/useLessonPlayback.ts';
import {
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

beforeEach(() => {
  audio = document.createElement('audio');
  let paused = true;
  Object.defineProperty(audio, 'paused', { get: () => paused });
  vi.spyOn(audio, 'play').mockImplementation(async () => {
    paused = false;
  });
  vi.spyOn(audio, 'pause').mockImplementation(() => {
    paused = true;
  });
  vi.spyOn(audio, 'load').mockImplementation(() => {});
  vi.stubGlobal('Audio', function Audio() {
    return audio;
  });
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:audio');
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

test('prepares on play, waits for the first block, then prepares exactly one ahead', async () => {
  const first = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback).mockReturnValueOnce(first.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  expect(getLessonPlayback).not.toHaveBeenCalled();
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalledTimes(1));
  expect(result.current.loading).toBe(true);
  expect(audio.play).not.toHaveBeenCalled();
  await act(async () => {
    first.resolve({ block: blocks[0], voice: 'Kore', model: 'tts' });
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalledTimes(2));
  expect(vi.mocked(prepareLessonPlayback).mock.calls.map(([request]) => request.blockId)).toEqual([
    '0',
    '1',
  ]);
  expect(audio.play).toHaveBeenCalledTimes(1);
  expect(result.current.loading).toBe(false);
  expect(result.current.playing).toBe(true);
  act(() => {
    audio.dispatchEvent(new Event('ended'));
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalledTimes(3));
  expect(vi.mocked(prepareLessonPlayback).mock.calls[2][0].blockId).toBe('2');
  expect(vi.mocked(prepareLessonPlayback).mock.calls[1][1]?.aborted).toBe(true);
});

test('a seek prepares its block at once instead of waiting for the preparation ahead', async () => {
  const ahead = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback)
    .mockResolvedValueOnce({ block: blocks[0], voice: 'Kore', model: 'tts' })
    .mockReturnValueOnce(ahead.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalledTimes(2));
  act(() => result.current.seek(25));
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalledTimes(3));
  expect(vi.mocked(prepareLessonPlayback).mock.calls[2][0].blockId).toBe('2');
  await waitFor(() => expect(result.current.index).toBe(2));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(audio.play).toHaveBeenCalledTimes(2);
  await act(async () => {
    ahead.resolve({ block: blocks[1], voice: 'Kore', model: 'tts' });
  });
  expect(result.current.blocks).toEqual(blocks);
});

test('a new selection aborts obsolete polling and late results cannot start another preparation', async () => {
  const pendingRuns = new Map<string, ReturnType<typeof deferred<void>>>();
  const completed = new Set<string>();
  vi.mocked(prepareLessonPlayback).mockImplementation(async request =>
    completed.has(request.blockId)
      ? { block: blocks[Number(request.blockId)], voice: 'Kore', model: 'tts' }
      : { runId: request.blockId, blockId: request.blockId, voice: 'Kore' }
  );
  vi.mocked(waitForLessonPlayback).mockImplementation(runId => {
    const run = deferred<void>();
    pendingRuns.set(runId, run);
    return run.promise;
  });
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(pendingRuns.has('0')).toBe(true));
  act(() => result.current.seek(15));
  await waitFor(() => expect(pendingRuns.has('1')).toBe(true));
  act(() => result.current.seek(25));
  await waitFor(() => expect(pendingRuns.has('2')).toBe(true));
  const signals = vi.mocked(waitForLessonPlayback).mock.calls.map(([, , signal]) => signal);
  expect(signals.map(signal => signal.aborted)).toEqual([true, true, false]);
  await act(async () => {
    completed.add('2');
    pendingRuns.get('2')?.resolve(undefined);
  });
  expect(result.current.index).toBe(2);
  expect(result.current.time).toBe(5);
  expect(result.current.playing).toBe(true);
  const readsBeforeLateResults = vi.mocked(getLessonPlayback).mock.calls.length;
  await act(async () => {
    pendingRuns.get('0')?.resolve(undefined);
    pendingRuns.get('1')?.resolve(undefined);
  });
  expect(getLessonPlayback).toHaveBeenCalledTimes(readsBeforeLateResults);
  expect(prepareLessonPlayback).toHaveBeenCalledTimes(4);
  expect(audio.play).toHaveBeenCalledOnce();
  expect(result.current.failed).toBe(false);
});

test.each([
  'pause',
  'voice',
  'unmount',
])('%s aborts a pending preparation and prevents a late response from continuing it', async action => {
  const pending = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockResolvedValueOnce({
    runId: 'run',
    blockId: '0',
    voice: 'Kore',
  });
  vi.mocked(waitForLessonPlayback).mockReturnValueOnce(pending.promise);
  const { result, rerender, unmount } = renderHook(
    ({ voice }) => useLessonPlayback({ ...target, voice }),
    { initialProps: { voice: 'Kore' } }
  );
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(waitForLessonPlayback).toHaveBeenCalledOnce());
  const signal = vi.mocked(waitForLessonPlayback).mock.calls[0][2];
  if (action === 'pause') act(() => result.current.pause());
  else if (action === 'voice') {
    rerender({ voice: 'Zephyr' });
    await waitFor(() => expect(result.current.loading).toBe(false));
  } else unmount();
  expect(signal.aborted).toBe(true);
  const requests = vi.mocked(prepareLessonPlayback).mock.calls.length;
  const reads = vi.mocked(getLessonPlayback).mock.calls.length;
  await act(async () => pending.resolve(undefined));
  expect(prepareLessonPlayback).toHaveBeenCalledTimes(requests);
  expect(getLessonPlayback).toHaveBeenCalledTimes(reads);
  if (action !== 'unmount') expect(result.current.failed).toBe(false);
});

test('a new selection aborts the previous asset download', async () => {
  const pending = deferred<Uint8Array>();
  vi.mocked(downloadProjectAssetBytes).mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(downloadProjectAssetBytes).toHaveBeenCalledOnce());
  const signal = vi.mocked(downloadProjectAssetBytes).mock.calls[0][2];
  act(() => result.current.seek(25));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(new Uint8Array([1])));
  expect(result.current.index).toBe(2);
  expect(result.current.time).toBe(5);
  expect(audio.play).toHaveBeenCalledOnce();
  expect(result.current.failed).toBe(false);
});

test('refreshes a stale lesson key before retrying preparation', async () => {
  vi.mocked(getLessonPlayback)
    .mockResolvedValueOnce({ lessonKey: 'old', blocks })
    .mockResolvedValue({ lessonKey: 'new', blocks });
  vi.mocked(prepareLessonPlayback).mockRejectedValueOnce(new LessonPlaybackRequestError(409));
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  expect(getLessonPlayback).toHaveBeenCalledTimes(2);
  expect(vi.mocked(prepareLessonPlayback).mock.calls[1][0].lessonKey).toBe('new');
  expect(result.current.failed).toBe(false);
});

test('waits for a 202 run before requesting another preparation', async () => {
  const committed = deferred<void>();
  vi.mocked(prepareLessonPlayback).mockResolvedValueOnce({
    runId: 'run',
    blockId: '0',
    voice: 'Kore',
  });
  vi.mocked(waitForLessonPlayback).mockReturnValueOnce(committed.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(waitForLessonPlayback).toHaveBeenCalledTimes(1));
  expect(prepareLessonPlayback).toHaveBeenCalledTimes(1);
  await act(async () => committed.resolve(undefined));
  await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
});

test('refreshing a lesson during preparation ahead pauses the old audio and resets its position', async () => {
  const ahead = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(getLessonPlayback)
    .mockResolvedValueOnce({ lessonKey: 'old', blocks })
    .mockResolvedValue({ lessonKey: 'new', blocks: [blocks[0]] });
  vi.mocked(prepareLessonPlayback)
    .mockResolvedValueOnce({ block: blocks[0], voice: 'Kore', model: 'tts' })
    .mockReturnValueOnce(ahead.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalledTimes(2));
  audio.currentTime = 7;
  expect(audio.paused).toBe(false);
  const pauses = vi.mocked(audio.pause).mock.calls.length;
  await act(async () => ahead.reject(new LessonPlaybackRequestError(409)));
  await waitFor(() => expect(result.current.blocks).toHaveLength(1));
  expect(result.current.playing).toBe(false);
  expect(result.current.index).toBe(0);
  expect(result.current.time).toBe(0);
  expect(audio.pause).toHaveBeenCalledTimes(pauses + 1);
  expect(audio.paused).toBe(true);
  expect(audio.currentTime).toBe(0);
  expect(prepareLessonPlayback).toHaveBeenCalledTimes(2);
  await act(async () => result.current.play());
  expect(vi.mocked(prepareLessonPlayback).mock.calls[2][0].lessonKey).toBe('new');
  expect(result.current.playing).toBe(true);
});

test('pausing during preparation prevents a late response from starting audio or preparing ahead', async () => {
  const prepared = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback).mockReturnValueOnce(prepared.promise);
  const { result } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalledTimes(1));
  act(() => result.current.pause());
  await act(async () => prepared.resolve({ block: blocks[0], voice: 'Kore', model: 'tts' }));
  expect(audio.play).not.toHaveBeenCalled();
  expect(prepareLessonPlayback).toHaveBeenCalledTimes(1);
});

test('unmount aborts pending preparation and releases the audio', async () => {
  const prepared = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback).mockReturnValueOnce(prepared.promise);
  const { result, unmount } = renderHook(() => useLessonPlayback(target));
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(prepareLessonPlayback).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => prepared.resolve({ block: blocks[0], voice: 'Kore', model: 'tts' }));
  expect(vi.mocked(prepareLessonPlayback).mock.calls[0][1]?.aborted).toBe(true);
  expect(audio.play).not.toHaveBeenCalled();
  expect(downloadProjectAssetBytes).not.toHaveBeenCalled();
});

test.each([
  'first play',
  'resume',
])('an intentional pause while %s is pending is not a failure', async mode => {
  const pending = deferred<void>();
  const { result } = renderHook(() => useLessonPlayback(target));
  if (mode === 'resume') {
    await act(async () => result.current.play());
    act(() => result.current.pause());
  }
  vi.mocked(audio.play).mockReturnValueOnce(pending.promise);
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(mode === 'resume' ? 2 : 1));
  act(() => result.current.pause());
  await act(async () => pending.reject(new DOMException('Interrupted', 'AbortError')));
  expect(result.current.failed).toBe(false);
  expect(result.current.playing).toBe(false);
  expect(result.current.loading).toBe(false);
});

test('a genuine audio failure remains visible', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(audio.play).mockRejectedValueOnce(new DOMException('Unsupported', 'NotSupportedError'));
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  expect(result.current.failed).toBe(true);
  expect(result.current.playing).toBe(false);
});

test('a cancelled play promise cannot fail a subsequent resume', async () => {
  const pending = deferred<void>();
  const { result } = renderHook(() => useLessonPlayback(target));
  vi.mocked(audio.play).mockReturnValueOnce(pending.promise);
  act(() => {
    void result.current.play();
  });
  await waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  act(() => result.current.pause());
  await act(async () => result.current.play());
  await act(async () => pending.reject(new DOMException('Interrupted', 'AbortError')));
  expect(result.current.failed).toBe(false);
  expect(result.current.playing).toBe(true);
});

test('handles a stale conflict on the request after a completed workflow', async () => {
  vi.mocked(getLessonPlayback)
    .mockResolvedValueOnce({ lessonKey: 'old', blocks })
    .mockResolvedValueOnce({ lessonKey: 'after-run', blocks })
    .mockResolvedValue({ lessonKey: 'new', blocks });
  vi.mocked(prepareLessonPlayback)
    .mockResolvedValueOnce({ runId: 'run', blockId: '0', voice: 'Kore' })
    .mockRejectedValueOnce(new LessonPlaybackRequestError(409));
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  expect(vi.mocked(prepareLessonPlayback).mock.calls[2][0].lessonKey).toBe('new');
  expect(result.current.failed).toBe(false);
  expect(result.current.playing).toBe(true);
});

test('uses the resolved voice and model for audio and the timeline', async () => {
  const canonical = blocks.map(block => ({
    ...block,
    audio: [
      { ...block.audio[0], voice: 'Ara', model: 'old-model', durationSeconds: 1 },
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
  expect(result.current.failed).toBe(false);
  expect(downloadProjectAssetBytes).toHaveBeenCalledWith(
    'project',
    canonical[0].audio[1].asset,
    expect.any(AbortSignal)
  );
  expect(result.current.duration).toBe(20);
  expect(result.current.total).toBe(60);
});

test('keeps the same relative position when the new voice has a different duration', async () => {
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
  audio.currentTime = 5;
  rerender({ voice: 'Zephyr' });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(audio.currentTime).toBe(10);
  expect(result.current.time).toBe(10);
});

test.each([
  2, 25,
])('ending the last block synchronizes seek to %s with the displayed block', async destination => {
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  act(() => result.current.seek(25));
  await waitFor(() => expect(result.current.index).toBe(2));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => audio.dispatchEvent(new Event('ended')));
  expect(result.current.index).toBe(0);
  expect(result.current.time).toBe(0);
  expect(result.current.duration).toBe(0);
  expect(audio.currentTime).toBe(0);
  act(() => result.current.seek(destination));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => result.current.play());
  expect(result.current.index).toBe(Math.floor(destination / 10));
  expect(audio.currentTime).toBe(destination % 10);
});
