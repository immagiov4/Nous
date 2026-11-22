import {
  type AlgorithmLessonScene,
  findLessonSceneProblems,
  LessonSceneSchema,
} from '@shared/lessonScene';
import {
  buildAlgorithmLayout,
  checkAlgorithmGeometry,
} from '@shared/lessonStudios/algorithmLayout';
import { type ArraySpec, arrayTrace, calloutIndices } from '@shared/lessonStudios/arrayAlgorithm';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { heapTrace } from '@shared/lessonStudios/heap';
import { arrayEventTimes, heapEventTimes } from '@shared/lessonStudios/traceTiming';
import { boxDistance, isVisible, vectorBounds } from '@shared/lessonStudios/vectorBounds';
import { absolutePosition, descendants } from '@shared/lessonStudios/vectorScene';
import { assert, expect, test } from 'vitest';

const opening = 'Sistemiamo i valori partendo dai figli.';
const extract = 'Spostiamo il massimo alla fine della lista.';
const built = 'Il valore più alto arriva in cima.';
const narration = `${opening} ${extract} ${built}`;

function scene(studio: AlgorithmLessonScene['studio'], anchor?: string): AlgorithmLessonScene {
  return {
    type: 'algorithm',
    title: 'Ordinamento',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [],
    narration,
    autoplay: true,
    studio,
    studioCues: anchor ? [{ anchor }] : [],
  };
}

test('an adjacent swap keeps the moving values clear at desktop scale', () => {
  const phrases = [
    'Bubble sort scorre la lista da sinistra a destra e confronta ogni coppia di elementi vicini.',
    'Se il primo è più grande del secondo, li scambia.',
    'Alla fine del primo passaggio, l’elemento più grande è “risalito” in fondo, come una bolla, e non va più toccato.',
    'Si ripete sulla parte ancora disordinata.',
  ];
  const bubble = {
    ...scene({
      id: 'array-algorithm',
      spec: {
        algorithm: 'bubble',
        input: [5, 1, 4, 2, 8],
        callouts: ['compare#1', 'swap#1', 'pass-end#1', 'compare#5'].map(event => ({ event })),
      },
    }),
    narration: phrases.join(' '),
    studioCues: phrases.map(anchor => ({ anchor })),
  };
  const viewport = readerStudioViewports.desktop;
  const layout = buildAlgorithmLayout(bubble, viewport);
  layout.seek(5050);
  const marks = [...descendants(layout.surface)].filter(isVisible);
  const values = marks.filter(node => node.hasClass('array-value'));
  const bars = marks.filter(node => node.hasClass('array-bar'));
  expect(values.map(node => Number(node.textContent)).sort((a, b) => a - b)).toEqual([
    1, 2, 4, 5, 8,
  ]);
  for (const value of values) {
    const ownBar = bars.find(bar => bar.parent?.parent === value.parent);
    assert(ownBar);
    const [ink] = vectorBounds(value);
    const [ownBarBounds] = vectorBounds(ownBar);
    for (const other of bars.filter(bar => bar !== ownBar))
      expect(boxDistance(ink, ownBarBounds)).toBeLessThan(boxDistance(ink, vectorBounds(other)[0]));
  }
  expect(checkAlgorithmGeometry(bubble, viewport)).toEqual([]);
});

test('a saved construction scene ends with the complete tree and row in heap order', () => {
  const spec = { input: [4, 10, 3, 5, 1], beats: [{ event: 'heapified' }] };
  const saved = {
    ...scene({ id: 'heap', spec }, built),
    studio: { id: 'heap', spec: { ...spec, operation: 'build' } },
  };
  const restored = LessonSceneSchema.parse(JSON.parse(JSON.stringify(saved)));
  if (restored.type !== 'algorithm') throw new Error('Expected an algorithm scene');
  const layout = buildAlgorithmLayout(restored);
  layout.seek(layout.durationMs);
  const nodes = [...descendants(layout.surface)];
  expect(nodes.filter(node => node.hasClass('heap-node') && isVisible(node))).toHaveLength(5);
  const row = nodes.filter(node => node.hasClass('heap-tile')).sort((a, b) => a.x - b.x);
  expect(row.map(node => node.attrs['data-value'])).toEqual([10, 5, 3, 4, 1]);
});

test('the lesson contract rejects an extraction cue in a construction scene', () => {
  const spec = { input: [4, 3], beats: [{ event: 'extract#1' }] };
  expect(
    findLessonSceneProblems(
      {
        ...scene({ id: 'heap', spec }, extract),
        studio: { id: 'heap', spec: { ...spec, operation: 'build' } },
      },
      narration,
      narration
    )
  ).toContain('Heap cue must name a computed event in order: extract#1');
});

test('an opening cue on bubble swap #2 leaves a visible interval for each prerequisite', () => {
  const spec: ArraySpec = {
    algorithm: 'bubble',
    input: [5, 1, 4, 2, 8],
    callouts: [{ event: 'swap#2' }],
  };
  const events = arrayTrace(spec);
  const times = arrayEventTimes(events, calloutIndices(spec, events), [0], 5);
  const [firstCompare, firstSwap, secondCompare, secondSwap] = times;
  expect(firstCompare).toBeLessThan(firstSwap);
  expect(firstSwap).toBeLessThan(secondCompare);
  expect(secondCompare).toBeLessThan(secondSwap);
  expect(secondSwap * 1000).toBeLessThanOrEqual(450);

  const layout = buildAlgorithmLayout({
    ...scene({ id: 'array-algorithm', spec }, opening),
    durationMs: 5000,
  });
  const firstTile = [...descendants(layout.surface)].find(node => node.hasClass('array-tile'));
  assert(firstTile);
  layout.seek(0);
  const initial = firstTile.x;
  layout.seek(((firstSwap + secondCompare) / 2) * 1000);
  expect(firstTile.x).toBeGreaterThan(initial);
  const inFlight = firstTile.x;
  layout.seek(secondCompare * 1000);
  expect(firstTile.x).toBeGreaterThan(inFlight);
});

test('sorting and search display close but distinct operands separately', () => {
  const sort = buildAlgorithmLayout(
    scene({
      id: 'array-algorithm',
      spec: { algorithm: 'bubble', input: [1.12341, 1.12349], callouts: [] },
    })
  );
  const search = buildAlgorithmLayout(
    scene({
      id: 'array-algorithm',
      spec: { algorithm: 'binary-search', input: [1.0001], target: 1.0002, callouts: [] },
    })
  );
  const values = (layout: typeof sort) =>
    [...descendants(layout.surface)]
      .filter(node => node.hasClass('array-value'))
      .map(node => node.textContent);
  expect(values(sort)).toEqual(['1,12341', '1,12349']);
  expect(values(search)).toEqual(['1,0001']);
  const target = [...descendants(search.surface)].find(node => node.hasClass('hud-label'));
  expect(target?.textContent).toContain('1,0002');
});

test('a no-swap narration cue shows the verdict after the preceding comparisons', () => {
  const spec: ArraySpec = {
    algorithm: 'bubble',
    input: [1, 2, 3],
    callouts: [{ event: 'no-swap-pass' }],
  };
  const events = arrayTrace(spec);
  const times = arrayEventTimes(events, calloutIndices(spec, events), [1000], 4);
  const verdict = events.findIndex(event => event.kind === 'no-swap-pass');
  expect(times[verdict]).toBe(1);
  expect(times[verdict - 1]).toBeLessThan(times[verdict]);
});

test.each([
  { operation: 'build', event: 'sift#1', next: 'heapified' },
  { operation: 'sort', event: 'extract#1', next: 'done' },
] as const)('an opening $event cue leaves earlier heap states visible before its action', ({
  operation,
  event,
  next,
}) => {
  const steps = heapTrace([1, 2], operation);
  const times = heapEventTimes(steps, [event, next], [0, 2000], 4);
  const named = steps.findIndex(step => step.event === event);
  expect(named).toBeGreaterThan(1);
  expect(times[named]).toBeGreaterThan(0);
  expect(times[named]).toBeLessThanOrEqual(0.45);
  for (let i = 1; i <= named; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
});

test('the extraction leader follows the extracted value as it moves to the sorted tail', () => {
  const layout = buildAlgorithmLayout(
    scene(
      {
        id: 'heap',
        spec: { input: [4, 3], beats: [{ event: 'extract#1' }] },
      },
      extract
    )
  );
  const nodes = [...descendants(layout.surface)];
  const tile = nodes.find(node => node.hasClass('heap-tile') && node.attrs['data-value'] === 4);
  const leader = nodes.find(node => node.hasClass('leader'));
  assert(tile && leader);
  for (const offset of [50, 300]) {
    layout.seek(layout.cues[0] + offset);
    expect(isVisible(leader)).toBe(true);
    const localX = Number(String(leader.attrs.points).split(',')[0]);
    const leaderX = absolutePosition(leader)[0] + localX;
    expect(Math.abs(leaderX - tile.x)).toBeLessThan(tile.children[0].number('width') / 2);
  }
});

test.each(
  Object.entries(readerStudioViewports)
)('heap extraction stays inside the %s reader and still moves both values', (_size, viewport) => {
  const phases = [opening, built, extract, 'Ora la lista è ordinata.'];
  const heap = {
    ...scene({
      id: 'heap',
      spec: {
        input: [4, 3],
        operation: 'sort',
        beats: ['start', 'heapified', 'extract#1', 'done'].map(event => ({ event })),
      },
    }),
    narration: phases.join(' '),
    studioCues: phases.map(anchor => ({ anchor })),
  };

  expect(checkAlgorithmGeometry(heap, viewport)).toEqual([]);
  const layout = buildAlgorithmLayout(heap, viewport);
  layout.seek(layout.durationMs);
  const row = [...descendants(layout.surface)]
    .filter(node => node.hasClass('heap-tile') && isVisible(node))
    .sort((a, b) => a.x - b.x);
  expect(row.map(node => node.attrs['data-value'])).toEqual([3, 4]);
});
