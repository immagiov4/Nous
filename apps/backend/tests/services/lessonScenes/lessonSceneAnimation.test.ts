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
  expect(findLessonSceneProblems(scene, 'Due. Quattro. Sei.')).toEqual([]);
  expect(findLessonSceneProblems(scene, 'Quattro. Due. Sei.')).toHaveLength(1);
  for (const incomplete of [
    cues.slice(0, 2),
    [{ ...cues[0], anchor: '' }, ...cues.slice(1)],
    [cues[1], cues[0], cues[2]],
    [...cues, { anchor: 'Otto', value: 8 }],
  ]) {
    expect(playbackMode({ ...scene, cues: incomplete })).toBe('automatic');
  }
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
