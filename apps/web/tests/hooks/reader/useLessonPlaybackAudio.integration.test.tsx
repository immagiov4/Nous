// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { LessonPlaybackResponseSchema } from '@shared/lessonPlaybackSchema';
import { act, renderHook, waitFor } from '@testing-library/react';
import SignalsmithStretch from 'signalsmith-stretch';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useLessonPlayback } from '../../../hooks/reader/useLessonPlayback.ts';
import {
  getLessonPlayback,
  prepareLessonPlayback,
} from '../../../services/openrouter/lessonPlaybackClient.ts';
import { downloadProjectAssetBytes } from '../../../services/projects/projectAssetClient.ts';
import { LessonPlaybackAudio } from '../../../utils/reader/lessonPlaybackAudio.ts';
import workletUrl from '../../../utils/reader/signalsmithWorklet?worker&url';

vi.mock('../../../services/openrouter/lessonPlaybackClient.ts', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../../services/openrouter/lessonPlaybackClient.ts')
  >()),
  getLessonPlayback: vi.fn(),
  prepareLessonPlayback: vi.fn(),
}));
vi.mock('../../../services/projects/projectAssetClient.ts', () => ({
  downloadProjectAssetBytes: vi.fn(),
}));

const buffer = {
  duration: 10,
  numberOfChannels: 1,
  getChannelData: () => new Float32Array([0, 1, 0]),
} as unknown as AudioBuffer;
const blocks = LessonPlaybackResponseSchema.parse({
  lessonKey: 'a'.repeat(64),
  blocks: segmentLessonPlayback([{ type: 'markdown', markdown: 'A local audio sample.' }]).map(
    block => ({
      ...block,
      audio: [
        {
          voice: 'Kore',
          model: 'tts',
          durationSeconds: 10,
          asset: { id: 'a'.repeat(64), hash: 'a'.repeat(64), byteSize: 1, mediaType: 'audio/mpeg' },
        },
      ],
    })
  ),
}).blocks;
type Failure =
  | 'module-load'
  | 'constructor'
  | 'processor'
  | 'context'
  | 'resume'
  | 'configuration'
  | null;
let failure: Failure;
let moduleLoad: Promise<void> | null;
let contexts: FakeContext[];
let nodes: FakeWorkletNode[];
let sequence = 0;

class FakeContext extends EventTarget {
  currentTime = 0;
  sampleRate = 48_000;
  createGain = () => ({
    gain: {
      value: 1,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  createBufferSource = () => ({
    buffer: null,
    start: vi.fn(),
    stop: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onended: null,
  });
  destination = {};
  state = 'suspended';
  loaded = false;
  onstatechange: (() => void) | null = null;
  audioWorklet = {
    addModule: vi.fn(async (_url: string) => {
      if (failure === 'module-load') throw new Error('Module unavailable');
      await moduleLoad;
      this.loaded = true;
    }),
  };
  resume = vi.fn(async () => {
    if (failure === 'resume') throw new Error('Resume unavailable');
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  decodeAudioData = vi.fn(async () => buffer);
  constructor() {
    super();
    if (failure === 'context') throw new Error('Context unavailable');
    contexts.push(this);
  }
}

class FakeWorkletNode extends EventTarget {
  onprocessorerror: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  port = {
    onmessage: (_event: { data: unknown[] }) => {},
    postMessage: vi.fn(([id, method]: unknown[]) => {
      queueMicrotask(() =>
        this.port.onmessage({
          data: failure === 'configuration' && method === 'setUpdateInterval' ? ['error'] : [id, 0],
        })
      );
    }),
  };
  constructor(context: FakeContext, name: string) {
    super();
    if (!context.loaded || failure === 'constructor') throw new Error('Processor unavailable');
    if (name === 'lesson-peak-limiter') return;
    nodes.push(this);
    queueMicrotask(() => {
      if (failure === 'processor') this.dispatchEvent(new Event('processorerror'));
      else
        this.port.onmessage({
          data: ['ready', { stop: 0, dropBuffers: 0, addBuffers: 1, schedule: 1 }],
        });
    });
  }
}

beforeEach(() => {
  failure = null;
  moduleLoad = null;
  contexts = [];
  nodes = [];
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.mocked(getLessonPlayback).mockResolvedValue({ lessonKey: 'a'.repeat(64), blocks });
  vi.mocked(prepareLessonPlayback).mockResolvedValue({
    block: blocks[0],
    voice: 'Kore',
    model: 'tts',
  });
  vi.mocked(downloadProjectAssetBytes).mockResolvedValue(new Uint8Array([1]));
});
afterEach(() => vi.unstubAllGlobals());

function player() {
  const projectId = `audio-boundary-${++sequence}`;
  return renderHook(() =>
    useLessonPlayback({
      projectId,
      sectionId: 'lesson',
      voice: 'Kore',
      speed: 1,
      initialBlocks: blocks,
    })
  );
}

test('constructs without audio side effects and loads the real factory through the worklet URL', async () => {
  const audio = new LessonPlaybackAudio();
  expect(contexts).toHaveLength(0);
  expect(vi.isMockFunction(SignalsmithStretch)).toBe(false);
  expect(SignalsmithStretch.moduleUrl).toBe(workletUrl);
  const ready = audio.ready();
  expect(audio.ready()).toBe(ready);
  await ready;
  expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledExactlyOnceWith(workletUrl);
  expect(nodes[0].connect).not.toHaveBeenCalled();
  expect(await audio.decode(new Uint8Array([1]))).toBe(buffer);
  audio.close();
});

test('unlocks the context during the gesture while the module is still loading', async () => {
  let complete = () => {};
  moduleLoad = new Promise<void>(resolve => {
    complete = resolve;
  });
  const audio = new LessonPlaybackAudio();
  const unlocking = audio.unlock();
  expect(contexts[0].resume).toHaveBeenCalledExactlyOnceWith();
  expect(nodes).toHaveLength(0);
  complete();
  await unlocking;
  expect(nodes).toHaveLength(1);
  audio.close();
});

test.each([
  'module-load',
  'constructor',
  'processor',
  'context',
  'resume',
  'configuration',
] as const)('%s failure settles the real player and retry starts a fresh advancing session', async mode => {
  failure = mode;
  const { result, unmount } = player();
  await act(async () => result.current.play());
  await waitFor(() => {
    expect(result.current.failed).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.playing).toBe(false);
  });
  const failedContext = contexts.at(-1);
  failure = null;
  await act(async () => result.current.play());
  await waitFor(() => expect(result.current.playing).toBe(true));
  expect(result.current.failed).toBe(false);
  expect(result.current.loading).toBe(false);
  const context = contexts.at(-1);
  const node = nodes.at(-1);
  assert(context);
  assert(node);
  expect(context).not.toBe(failedContext);
  if (failedContext) expect(failedContext.close).toHaveBeenCalled();
  context.currentTime = 2;
  act(() => node.port.onmessage({ data: ['time', 2] }));
  expect(result.current.time).toBe(2);
  unmount();
});

test.each([
  'processor',
  'context',
] as const)('%s failure interrupts active playback and permits retry', async mode => {
  const { result, unmount } = player();
  await act(async () => result.current.play());
  await waitFor(() => expect(result.current.playing).toBe(true));
  act(() => {
    if (mode === 'processor') nodes[0].onprocessorerror?.();
    else {
      contexts[0].state = 'closed';
      contexts[0].onstatechange?.();
    }
  });
  expect(result.current.failed).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(result.current.playing).toBe(false);
  await act(async () => result.current.play());
  await waitFor(() => expect(result.current.playing).toBe(true));
  expect(result.current.failed).toBe(false);
  unmount();
});
