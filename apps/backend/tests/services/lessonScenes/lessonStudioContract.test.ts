import {
  type AlgorithmLessonScene,
  findLessonSceneProblems,
  LessonSceneSchema,
} from '@shared/lessonScene';
import {
  buildAlgorithmLayout,
  checkAlgorithmGeometry,
} from '@shared/lessonStudios/algorithmLayout';
import { arrayTrace } from '@shared/lessonStudios/arrayAlgorithm';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { heapTrace } from '@shared/lessonStudios/heap';
import { isVisible } from '@shared/lessonStudios/vectorBounds';
import { descendants } from '@shared/lessonStudios/vectorScene';
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

test.each(
  Object.entries(readerStudioViewports)
)('binary search shows its comparison count on the %s reader', (_size, viewport) => {
  const scene = LessonSceneSchema.parse({
    ...algorithmScene({
      id: 'array-algorithm',
      spec: { algorithm: 'binary-search', input: [1, 2, 4, 8], target: 4, callouts: [] },
    }),
    studioCues: [],
  }) as AlgorithmLessonScene;
  const layout = buildAlgorithmLayout(scene, viewport);
  const count = () =>
    [...descendants(layout.surface)].find(node => node.hasClass('hud-number') && isVisible(node))
      ?.textContent;
  layout.seek(0);
  expect(count()).toBe('0');
  layout.seek(layout.durationMs);
  expect(count()).toBe('2');
  layout.seek(0);
  expect(count()).toBe('0');
  expect(checkAlgorithmGeometry(scene, viewport)).toEqual([]);
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

test('the heap layout places extracted maxima in the array and restores the original tree after a seek', () => {
  const input = [4, 10, 3, 5, 1];
  const heapNarration =
    'Per prima cosa sistemiamo i nodi nello heap. Il massimo arriva in cima allo heap. Spostiamo il massimo alla fine della lista. Ripetiamo finché la lista è ordinata.';
  const scene: AlgorithmLessonScene = {
    ...algorithmScene(null),
    type: 'algorithm',
    studio: {
      id: 'heap',
      spec: {
        input,
        beats: [
          { event: 'start' },
          { event: 'heapified' },
          { event: 'extract#1' },
          { event: 'done' },
        ],
      },
    },
    studioCues: heapNarration.match(/[^.]+\./gu)!.map(sentence => ({ anchor: sentence.trim() })),
    narration: heapNarration,
  };
  const layout = buildAlgorithmLayout(scene);
  const nodes = [...descendants(layout.surface)];
  const row = () =>
    nodes
      .filter(node => node.hasClass('heap-tile'))
      .sort((a, b) => a.x - b.x)
      .map(node => node.attrs['data-value']);
  const visibleTree = () =>
    nodes
      .filter(node => node.hasClass('heap-node') && isVisible(node))
      .map(node => node.attrs['data-value']);
  layout.seek(0);
  expect(row()).toEqual(input);
  expect(visibleTree()).toEqual(input);
  layout.seek(layout.durationMs);
  expect(row()).toEqual([1, 3, 4, 5, 10]);
  expect(visibleTree()).not.toContain(10);
  layout.seek(0);
  expect(row()).toEqual(input);
  expect(visibleTree()).toEqual(input);
});
