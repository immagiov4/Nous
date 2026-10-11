import { LessonSceneSchema } from '@shared/lessonPlaybackSchema';
import { findLessonSceneProblems } from '@shared/lessonScene';
import {
  automaticDuration,
  automaticQuantity,
  cueTimes,
  pathFrame,
  playbackMode,
  proportionalResult,
  textFrame,
} from '@shared/lessonSceneAnimation';
import { expect, test } from 'vitest';
import { ProjectVisualSchema } from '../../../src/workflows/lessonGenerationWorkflowSchemas';
import { guidedPathScene, proportionalScene } from '../../helpers/animatedLessonScenes';

test.each([
  proportionalScene,
  guidedPathScene,
])('accepts and durably preserves the prototype $type example', scene => {
  expect(findLessonSceneProblems(scene, scene.narration)).toEqual([]);
  expect(LessonSceneSchema.parse(scene)).toEqual(scene);
  expect(ProjectVisualSchema.parse({ kind: 'scene', scene })).toEqual({ kind: 'scene', scene });
});

test.each([
  { min: 0 },
  { min: 1.5 },
  { max: 0 },
  { max: 1 },
  { initial: 0 },
  { initial: 7 },
  { initial: 2.5 },
  { amountPerUnit: 0 },
  { amountPerUnit: Number.POSITIVE_INFINITY },
  { durationMs: 0 },
  { durationMs: Number.NaN },
  { autoplay: undefined },
  { inputLabel: '' },
  { unitLabel: ' ' },
  { outputUnit: '' },
  { outputLabel: '' },
  { assumption: '' },
])('rejects invalid quantity data %j', change => {
  expect(findLessonSceneProblems({ ...proportionalScene, ...change }).length).toBeGreaterThan(0);
});

test('requires at least two fully labelled path steps', () => {
  for (const steps of [
    [],
    guidedPathScene.steps.slice(0, 1),
    [{ ...guidedPathScene.steps[0], label: '' }, guidedPathScene.steps[1]],
    [{ ...guidedPathScene.steps[0], detail: ' ' }, guidedPathScene.steps[1]],
  ]) {
    expect(findLessonSceneProblems({ ...guidedPathScene, steps }).length).toBeGreaterThan(0);
  }
});

test.each([1, 2, 4, 5, 8, 9])('validates the approved guided-path boundary at %i steps', count => {
  const scene = {
    ...guidedPathScene,
    steps: Array.from({ length: count }, (_, index) => ({
      label: `Step ${index}`,
      detail: `Detail ${index}`,
    })),
  };
  expect(findLessonSceneProblems(scene).length === 0).toBe(count >= 2 && count <= 8);
});

test('accepts source-grounded proportional quantities beyond the replica display limit', () => {
  expect(
    findLessonSceneProblems(
      { ...proportionalScene, max: 1000000 },
      '1, 2, 1000000 units; 128 MB each.'
    )
  ).toEqual([]);
});

test('validates exact, unique, ordered quotations against the supplied lesson text', () => {
  const source = guidedPathScene.narration as string;
  expect(findLessonSceneProblems(guidedPathScene, source)).toEqual([]);
  expect(findLessonSceneProblems(guidedPathScene, `${source} L’interfaccia`)).toHaveLength(1);
  expect(findLessonSceneProblems(guidedPathScene, source.replace('l’API', 'l’api'))).toHaveLength(
    1
  );
  expect(
    findLessonSceneProblems(
      { ...guidedPathScene, steps: [...guidedPathScene.steps].reverse() },
      source
    )
  ).toHaveLength(1);
  expect(findLessonSceneProblems({ ...guidedPathScene, narration: undefined })).toEqual([]);
  const grouped = {
    ...guidedPathScene,
    steps: [
      guidedPathScene.steps[0],
      { ...guidedPathScene.steps[1], anchor: 'L’interfaccia' },
      ...guidedPathScene.steps.slice(2),
    ],
  };
  expect(findLessonSceneProblems(grouped, source)).toEqual([]);
  expect(cueTimes(source, grouped.steps).slice(0, 2)).toEqual([0, 0]);
});

test('chooses word timing only for complete step or cumulative quantity assignments', () => {
  expect(playbackMode(guidedPathScene)).toBe('text');
  expect(
    playbackMode({
      ...guidedPathScene,
      steps: guidedPathScene.steps.map((step, index) =>
        index === 1 ? { ...step, anchor: undefined } : step
      ),
    })
  ).toBe('automatic');
  expect(playbackMode(proportionalScene)).toBe('automatic');
  const cues = [
    { anchor: 'Due', value: 2 },
    { anchor: 'Quattro', value: 4 },
    { anchor: 'Sei', value: 6 },
  ];
  const scene = { ...proportionalScene, cues };
  expect(playbackMode(scene)).toBe('text');
  expect(findLessonSceneProblems(scene, '1 2 6 128. Due. Quattro. Sei.')).toEqual([]);
  expect(findLessonSceneProblems(scene, '1 2 6 128. Quattro. Due. Sei.')).toHaveLength(1);
  for (const incomplete of [
    cues.slice(0, 2),
    [{ ...cues[0], anchor: '' }, ...cues.slice(1)],
    [cues[1], cues[0], cues[2]],
    [...cues, { anchor: 'Otto', value: 8 }],
  ]) {
    expect(playbackMode({ ...scene, cues: incomplete })).toBe('automatic');
  }
});

test.each([
  0,
  1,
  1.5,
  7,
  Number.NaN,
  Number.POSITIVE_INFINITY,
])('rejects unsafe quantity cue %s and excludes it from word timing', value => {
  const scene = {
    ...proportionalScene,
    min: 2,
    cues: [
      { anchor: 'First', value },
      { anchor: 'Last', value: 6 },
    ],
  };
  expect(findLessonSceneProblems(scene).length).toBeGreaterThan(0);
  expect(playbackMode(scene)).toBe('automatic');
});

test('rejects a cue below the initial quantity even when inside the bounds', () => {
  const scene = {
    ...proportionalScene,
    cues: [
      { anchor: 'First', value: 1 },
      { anchor: 'Last', value: 6 },
    ],
  };
  expect(findLessonSceneProblems(scene).length).toBeGreaterThan(0);
  expect(playbackMode(scene)).toBe('automatic');
});

test('grounds every proportional parameter in lesson numbers while preserving stored scenes', () => {
  const source = 'Da 1 a 6 repliche, inizialmente 2, con 128 MB ciascuna.';
  expect(findLessonSceneProblems(proportionalScene, source)).toEqual([]);
  for (const lesson of ['2 6 128', '1 2 128', '1 6 128', '1 2 6']) {
    expect(findLessonSceneProblems(proportionalScene, lesson)).toHaveLength(1);
  }
  expect(findLessonSceneProblems(proportionalScene)).toEqual([]);
});

test('only identical anchors may share a source offset', () => {
  expect(() =>
    cueTimes('Alpha beta gamma', [{ anchor: 'Alpha' }, { anchor: 'Alpha beta' }])
  ).toThrow('Anchor must be unique and ordered');
  expect(cueTimes('Alpha beta gamma', [{ anchor: 'Alpha' }, { anchor: 'Alpha' }])).toEqual([0, 0]);
  expect(
    findLessonSceneProblems(
      {
        ...guidedPathScene,
        steps: [
          { label: 'A', detail: 'First', anchor: 'Alpha' },
          { label: 'B', detail: 'Next', anchor: 'Alpha beta' },
        ],
      },
      'Alpha beta gamma'
    )
  ).toHaveLength(1);
});

test('derives quantities and path frames at prototype boundaries and backward seeks', () => {
  expect(automaticDuration(proportionalScene)).toBe(9600);
  expect(automaticDuration({ ...proportionalScene, durationMs: undefined })).toBe(12000);
  expect(automaticDuration(guidedPathScene)).toBe(9600);
  expect(
    [-1, 0, 2399, 2400, 4800, 9600, 20000].map(time => automaticQuantity(proportionalScene, time))
  ).toEqual([2, 2, 2, 3, 4, 6, 6]);
  expect(proportionalResult(proportionalScene, 4)).toBe(512);
  expect(() => proportionalResult(proportionalScene, 7)).toThrow();
  expect(pathFrame(0, 4)).toEqual({ index: 0, progress: 0, complete: false });
  expect(pathFrame(4800, 4)).toEqual({ index: 2, progress: 0.5, complete: false });
  expect(pathFrame(20000, 4)).toEqual({ index: 3, progress: 1, complete: true });
  expect(pathFrame(-1, 4).index).toBe(0);
  expect(cueTimes('Uno due tre', [{ anchor: 'Uno' }, { anchor: 'tre' }])).toEqual([0, 500]);
  expect(textFrame(500, 'Uno due tre', [0, 500])).toEqual({
    wordIndex: 2,
    index: 1,
    complete: false,
  });
  expect(textFrame(750, 'Uno due tre', [0, 500]).complete).toBe(true);
});

test.each([
  [0.1, 0.3],
  [0.07, 0.21],
  [0.1234567890123456, 0.3703703670370368],
  [1.23456789, 3.70370367],
  [1e-25, 3e-25],
  [1.2e25, 3.6e25],
])('multiplies the decimal unit amount %s without arithmetic noise', (amountPerUnit, total) => {
  expect(proportionalResult({ ...proportionalScene, amountPerUnit }, 3)).toBe(total);
});

test.each([
  [1, 13, 28800],
  [10, 1000000, 28800],
  [100, 105, 14400],
])('aggregate playback samples %i..%i in at most twelve 2.4-second steps', (min, max, expectedDuration) => {
  const scene = { ...proportionalScene, min, max, initial: min + 1, durationMs: undefined };
  const count = Math.min(12, max - min + 1);
  const duration = automaticDuration(scene);
  expect(duration).toBe(expectedDuration);
  const quantities = Array.from({ length: count }, (_, index) => {
    const quantity = automaticQuantity(scene, index * 2400);
    expect(automaticQuantity(scene, index * 2400 + 2399)).toBe(quantity);
    return quantity;
  });
  expect(new Set(quantities).size).toBe(count);
  const increments = quantities.slice(1).map((quantity, index) => quantity - quantities[index]);
  expect(Math.max(...increments) - Math.min(...increments)).toBeLessThanOrEqual(1);
  expect(quantities[0]).toBe(min);
  expect(quantities.at(-1)).toBe(max);
  expect(automaticQuantity(scene, duration + 2400)).toBe(max);
  expect(automaticQuantity(scene, -1)).toBe(min);
  const owned = { ...scene, durationMs: 60000 };
  expect(automaticDuration(owned)).toBe(60000);
  expect(automaticQuantity(owned, 60000)).toBe(max);
  expect(automaticQuantity(owned, 0)).toBe(min);
});
