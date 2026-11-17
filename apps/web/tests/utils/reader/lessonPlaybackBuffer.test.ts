import { expect, test } from 'vitest';
import {
  PlaybackPreparationQueue,
  playbackBufferIndexes,
} from '../../../utils/reader/lessonPlaybackBuffer.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test('requests a time horizon rather than a fixed number of clips and accounts for speed', () => {
  const durations = [1, 1, 1, 10, 20, 40, 90].map(duration => ({ duration }));
  expect(playbackBufferIndexes(durations, 0, 1)).toEqual([1, 2, 3, 4, 5]);
  expect(playbackBufferIndexes(durations, 0, 2)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(playbackBufferIndexes(durations, 6, 1)).toEqual([]);
});

test('allows three preparations while further clips wait, then fills the released slot', async () => {
  const queue = new PlaybackPreparationQueue();
  const first = deferred(),
    second = deferred(),
    third = deferred();
  const entered: number[] = [];
  const signal = new AbortController().signal;
  const one = queue.run(async () => {
    entered.push(1);
    await first.promise;
  }, signal);
  const two = queue.run(async () => {
    entered.push(2);
    await second.promise;
  }, signal);
  const three = queue.run(async () => {
    entered.push(3);
    await third.promise;
  }, signal);
  const four = queue.run(async () => {
    entered.push(4);
  }, signal);
  expect(entered).toEqual([1, 2, 3]);
  first.resolve();
  await one;
  await four;
  expect(entered).toEqual([1, 2, 3, 4]);
  second.resolve();
  third.resolve();
  await Promise.all([two, three]);
});

test('seek removes queued prefetch before its provider operation starts', async () => {
  const queue = new PlaybackPreparationQueue();
  const active = deferred();
  const controller = new AbortController();
  const one = queue.run(() => active.promise, new AbortController().signal);
  const two = queue.run(() => active.promise, new AbortController().signal);
  const three = queue.run(() => active.promise, new AbortController().signal);
  let started = false;
  const obsolete = queue.run(async () => {
    started = true;
  }, controller.signal);
  controller.abort();
  await expect(obsolete).rejects.toMatchObject({ name: 'AbortError' });
  active.resolve();
  await Promise.all([one, two, three]);
  expect(started).toBe(false);
});
