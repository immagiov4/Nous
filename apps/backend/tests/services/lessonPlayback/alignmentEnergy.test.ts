import { expect, test } from 'vitest';
import {
  trimRecordingSilence,
  trimWordSilence,
} from '../../../src/services/lessonPlayback/alignmentEnergy.js';

test('removes the pause attributed to the next word and retains already voiced boundaries', () => {
  const sampleRate = 16000;
  const samples = new Float32Array(sampleRate);
  for (const [start, end] of [
    [0.1, 0.2],
    [0.65, 0.85],
  ]) {
    for (let i = start * sampleRate; i < end * sampleRate; i++) samples[i] = 0.3 * Math.sin(i);
  }
  const result = trimWordSilence(samples, sampleRate, [
    { begin: 0.1, end: 0.2 },
    { begin: 0.2, end: 0.85 },
  ]);
  expect(result[0]).toBe(0.1);
  expect(result[1]).toBeCloseTo(0.635, 3);
  expect(trimWordSilence(samples, sampleRate, [{ begin: 0.7, end: 0.85 }])[0]).toBeCloseTo(0.7, 10);
});

test('keeps silence-only, zero-duration and sub-window fragments stable', () => {
  const fragments = [
    { begin: 0, end: 0.3 },
    { begin: 0.3, end: 0.3 },
  ];
  expect(trimWordSilence(new Float32Array(16000), 16000, fragments)).toEqual([0, 0.3]);
  expect(trimWordSilence(new Float32Array(8), 16000, [{ begin: 0, end: 0 }])).toEqual([0]);
});

test('rejects invalid saved audio instead of storing guessed onsets', async () => {
  await expect(trimRecordingSilence(new Uint8Array([73, 68, 51]), [])).rejects.toThrow(
    'Invalid recording alignment audio.'
  );
});
