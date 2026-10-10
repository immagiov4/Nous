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
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
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
    first.resolve({ block: blocks[0] });
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
});

test('a seek prepares its block at once instead of waiting for the preparation ahead', async () => {
  const ahead = deferred<Awaited<ReturnType<typeof prepareLessonPlayback>>>();
  vi.mocked(prepareLessonPlayback)
    .mockResolvedValueOnce({ block: blocks[0] })
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
    ahead.resolve({ block: blocks[1] });
  });
  expect(result.current.blocks).toEqual(blocks);
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
  vi.mocked(getLessonPlayback)
    .mockResolvedValueOnce({ lessonKey: 'old', blocks })
    .mockResolvedValue({ lessonKey: 'new', blocks: [blocks[0]] });
  vi.mocked(prepareLessonPlayback)
    .mockResolvedValueOnce({ block: blocks[0] })
    .mockRejectedValueOnce(new LessonPlaybackRequestError(409));
  const { result } = renderHook(() => useLessonPlayback(target));
  await act(async () => result.current.play());
  await waitFor(() => expect(result.current.blocks).toHaveLength(1));
  expect(result.current.playing).toBe(false);
  expect(result.current.index).toBe(0);
  expect(result.current.time).toBe(0);
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
  await act(async () => prepared.resolve({ block: blocks[0] }));
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
  await act(async () => prepared.resolve({ block: blocks[0] }));
  expect(vi.mocked(prepareLessonPlayback).mock.calls[0][1]?.aborted).toBe(true);
  expect(audio.play).not.toHaveBeenCalled();
  expect(downloadProjectAssetBytes).not.toHaveBeenCalled();
});
