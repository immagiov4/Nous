import { findLessonSceneProblems, LessonSceneSchema } from '@shared/lessonScene';
import { arrayTrace } from '@shared/lessonStudios/arrayAlgorithm';
import { heapTrace } from '@shared/lessonStudios/heap';
import { describe, expect, test } from 'vitest';

const narration = 'Confrontiamo quattro e tre. I due valori si scambiano.';
const anchors = [
  { anchor: 'Confrontiamo quattro e tre.' },
  { anchor: 'I due valori si scambiano.' },
];

function algorithmScene(studio: unknown) {
  return {
    type: 'algorithm',
    title: 'Ordinamento',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: [],
    autoplay: true,
    narration,
    studio,
    studioCues: anchors,
  };
}

describe('algorithm lesson studio', () => {
  test('round-trips a computed array trace through the lesson scene contract', () => {
    const scene = algorithmScene({
      id: 'array-algorithm',
      spec: {
        algorithm: 'bubble',
        input: [4, 3],
        callouts: [{ event: 'compare#1' }, { event: 'swap#1' }],
      },
    });
    expect(findLessonSceneProblems(scene, narration, narration)).toEqual([]);
    expect(LessonSceneSchema.parse(JSON.parse(JSON.stringify(scene)))).toEqual(scene);
  });

  test('rejects an event the heap does not compute for its input', () => {
    const scene = algorithmScene({
      id: 'heap',
      spec: { input: [4, 3], beats: [{ event: 'sift#1' }, { event: 'done' }] },
    });
    expect(findLessonSceneProblems(scene, narration, narration)).toContain(
      'Heap cue must name a computed event in order: sift#1'
    );
  });
});

test.each([
  'bubble',
  'insertion',
  'selection',
] as const)('%s preserves every value while sorting negative and repeated entries', algorithm => {
  const input = [5, 1, 4, 2, 8, 1, -3];
  const frame = arrayTrace({ algorithm, input, callouts: [] }).at(-1);
  expect(frame?.order.map(index => input[index])).toEqual([-3, 1, 1, 2, 4, 5, 8]);
});

test.each([
  [4, 'found'],
  [3, 'not-found'],
] as const)('binary-search for %i reaches %s', (target, result) => {
  const frame = arrayTrace({
    algorithm: 'binary-search',
    input: [1, 2, 4, 8],
    target,
    callouts: [],
  }).at(-1);
  expect(frame?.kind).toBe(result);
});

test('heap extraction moves each maximum from the tree to the end of the array', () => {
  const input = [4, 10, 3, 5, 1];
  const trace = heapTrace(input);
  expect(trace.find(step => step.event === 'heapified')?.order.map(index => input[index])).toEqual([
    10, 5, 3, 4, 1,
  ]);
  expect(
    trace.flatMap(({ extracted }) => (extracted === undefined ? [] : [input[extracted]]))
  ).toEqual([10, 5, 4, 3, 1]);
  expect(trace.at(-1)?.order.map(index => input[index])).toEqual([1, 3, 4, 5, 10]);
});
