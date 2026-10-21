// @vitest-environment jsdom

import SignalsmithStretch from 'signalsmith-stretch';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LessonPlaybackAudio } from '../../../utils/reader/lessonPlaybackAudio.ts';

const clockNotifications = vi.hoisted(() => ({
  update: (): void => {
    throw new Error('Audio clock listener not installed');
  },
}));
const stretch = vi.hoisted(() => ({
  setUpdateInterval: vi.fn(async (_seconds: number, update: () => void) => {
    clockNotifications.update = update;
  }),
  connect: vi.fn(),
  schedule: vi.fn(async () => ({})),
  stop: vi.fn(async () => {}),
  addBuffers: vi.fn(async (_channels: Float32Array[]) => 0),
  dropBuffers: vi.fn(async () => {}),
}));
vi.mock('signalsmith-stretch', () => ({ default: vi.fn(async () => stretch) }));
let clock: {
  currentTime: number;
  destination: object;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
let audio: LessonPlaybackAudio;
const recording = (index: number, duration = 1) => ({
  index,
  buffer: {
    duration,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array([index, index]),
  } as unknown as AudioBuffer,
});

beforeEach(() => {
  clock = {
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  vi.stubGlobal('AudioContext', function MockAudioContext() {
    return clock;
  });
  audio = new LessonPlaybackAudio();
});
afterEach(() => {
  audio.close();
  vi.unstubAllGlobals();
});

test('streams contiguous samples once and changes passage without starting another sound', async () => {
  const positions = vi.fn(),
    ended = vi.fn();
  audio.onPosition = positions;
  audio.onEnded = ended;
  await audio.start([recording(0), recording(1)], 0, 1, new AbortController().signal);
  expect(stretch.addBuffers.mock.calls.map(([channels]) => [...channels[0]])).toEqual([
    [0, 0],
    [1, 1],
  ]);
  expect(stretch.schedule).toHaveBeenCalledTimes(1);
  expect(stretch.schedule).toHaveBeenCalledWith({
    active: true,
    input: 0,
    output: 0,
    outputTime: 0,
    rate: 1,
    semitones: 0,
  });
  clock.currentTime = 1;
  clockNotifications.update();
  expect(audio.position).toEqual({ index: 1, time: 0, duration: 1 });
  expect(positions).toHaveBeenLastCalledWith({ index: 1, time: 0, duration: 1 });
  expect(stretch.schedule).toHaveBeenCalledTimes(1);
  expect(ended).not.toHaveBeenCalled();
  clock.currentTime = 2;
  clockNotifications.update();
  expect(ended).toHaveBeenCalledTimes(1);
});

test('serializes overlapping appends without duplicating or reordering samples', async () => {
  await audio.start([recording(0)], 0, 1, new AbortController().signal);
  await Promise.all([
    audio.append([recording(0), recording(1)]),
    audio.append([recording(0), recording(1), recording(2)]),
  ]);
  expect(stretch.addBuffers.mock.calls.map(([channels]) => channels[0][0])).toEqual([0, 1, 2]);
  clock.currentTime = 2;
  expect(audio.position).toEqual({ index: 2, time: 0, duration: 1 });
});

test('speed changes preserve position and pitch without restarting buffers', async () => {
  await audio.start([recording(0, 10), recording(1, 10)], 2, 1, new AbortController().signal);
  clock.currentTime = 3;
  audio.changeSpeed(2);
  await Promise.resolve();
  expect(stretch.schedule).toHaveBeenLastCalledWith({
    input: 5,
    output: 3,
    outputTime: 3,
    rate: 2,
    semitones: 0,
  });
  clock.currentTime = 5;
  expect(audio.position).toEqual({ index: 0, time: 9, duration: 10 });
  expect(stretch.dropBuffers).toHaveBeenCalledTimes(1);
  audio.pause();
  clock.currentTime = 9;
  expect(audio.position).toEqual({ index: 0, time: 9, duration: 10 });
});

test('a pause while buffers are loading prevents the stale stream from starting', async () => {
  let release = () => {};
  stretch.addBuffers.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = () => resolve(1);
      })
  );
  const start = audio.start([recording(0)], 0, 1, new AbortController().signal);
  await vi.waitFor(() => expect(stretch.addBuffers).toHaveBeenCalled());
  audio.pause();
  release();
  await start;
  expect(stretch.schedule).not.toHaveBeenCalled();
});

test('an aborted start never schedules audio and selecting a passage exposes the paused position', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(audio.start([recording(0)], 0, 1, controller.signal)).rejects.toThrow();
  expect(stretch.schedule).not.toHaveBeenCalled();
  audio.select(recording(3, 10), 7);
  expect(audio.position).toEqual({ index: 3, time: 7, duration: 10 });
});

test('audio clock notifications advance passages when animation frames are suspended', async () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 0)
  );
  const positions = vi.fn();
  audio.onPosition = positions;
  await audio.start([recording(0), recording(1)], 0, 1, new AbortController().signal);
  clock.currentTime = 1;
  clockNotifications.update();
  expect(positions).toHaveBeenLastCalledWith({ index: 1, time: 0, duration: 1 });
});

test('a late append reports exhaustion instead of skipping the next clip opening', async () => {
  const ended = vi.fn();
  audio.onEnded = ended;
  await audio.start([recording(0)], 0, 1, new AbortController().signal);
  clock.currentTime = 1.05;
  await audio.append([recording(0), recording(1)]);
  expect(ended).toHaveBeenCalledTimes(1);
  expect(audio.position).toEqual({ index: 0, time: 1, duration: 1 });
  expect(stretch.addBuffers).toHaveBeenCalledTimes(1);
});

test('initialization failure rejects start and an explicit unlock creates a working session', async () => {
  audio.close();
  vi.mocked(SignalsmithStretch).mockRejectedValueOnce(new Error('Module load failed'));
  audio = new LessonPlaybackAudio();
  const failed = vi.fn();
  audio.onError = failed;
  await vi.waitFor(() => expect(failed).toHaveBeenCalled());
  await expect(audio.start([recording(0)], 0, 1, new AbortController().signal)).rejects.toThrow(
    'Module load failed'
  );
  await audio.unlock();
  await audio.start([recording(0)], 0, 1, new AbortController().signal);
  clock.currentTime = 1;
  expect(audio.position?.time).toBe(1);
});

test('a context constructor failure is observable and retry creates a context', async () => {
  audio.close();
  let fail = true;
  vi.stubGlobal('AudioContext', function MockAudioContext() {
    if (fail) {
      fail = false;
      throw new Error('Context failed');
    }
    return clock;
  });
  audio = new LessonPlaybackAudio();
  const failed = vi.fn();
  audio.onError = failed;
  await vi.waitFor(() => expect(failed).toHaveBeenCalled());
  await audio.unlock();
  await audio.start([recording(0)], 0, 1, new AbortController().signal);
  expect(audio.position).toEqual({ index: 0, time: 0, duration: 1 });
});

test('resume rejection reports an error and an explicit unlock recovers', async () => {
  const failed = vi.fn();
  audio.onError = failed;
  clock.resume.mockRejectedValueOnce(new Error('Context resume failed'));
  await expect(audio.unlock()).rejects.toThrow('Context resume failed');
  expect(failed).toHaveBeenCalled();
  await audio.unlock();
  await audio.start([recording(0)], 0, 1, new AbortController().signal);
  expect(audio.position).toEqual({ index: 0, time: 0, duration: 1 });
});

test('a failed stop from the retired session cannot interrupt playback after retry', async () => {
  let rejectStop = (_error: Error) => {};
  stretch.stop.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectStop = reject;
      })
  );
  clock.resume.mockRejectedValueOnce(new Error('Resume failed'));
  const failed = vi.fn();
  audio.onError = failed;
  await expect(audio.start([recording(0)], 0, 1, new AbortController().signal)).rejects.toThrow(
    'Resume failed'
  );
  await vi.waitFor(() => expect(stretch.stop).toHaveBeenCalled());
  await audio.unlock();
  await audio.start([recording(0)], 0, 1, new AbortController().signal);
  const errorsBeforeRetiredStop = failed.mock.calls.length;
  rejectStop(new Error('Retired context closed'));
  await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(errorsBeforeRetiredStop));
  await new Promise<void>(resolve => queueMicrotask(resolve));
  clock.currentTime = 1;
  expect(failed).toHaveBeenCalledTimes(errorsBeforeRetiredStop);
  expect(audio.position?.time).toBe(1);
});
