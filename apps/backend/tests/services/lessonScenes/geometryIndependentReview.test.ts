import type { GeometryLessonScene } from '@shared/lessonScene';
import {
  buildAlgorithmLayout,
  checkAlgorithmGeometry,
} from '@shared/lessonStudios/algorithmLayout';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { findGeometryProblems } from '@shared/lessonStudios/geometry';
import { buildGraph, GraphSpecSchema } from '@shared/lessonStudios/graph';
import { planeCopy } from '@shared/lessonStudios/plane.copy.it';
import { PlaneSpecSchema } from '@shared/lessonStudios/planeSpec';
import { isVisible } from '@shared/lessonStudios/vectorBounds';
import { descendants, VectorNode } from '@shared/lessonStudios/vectorScene';
import { assert, expect, test } from 'vitest';

function scene(
  geometryStudio: GeometryLessonScene['geometryStudio'],
  phrases: string[]
): GeometryLessonScene {
  return {
    type: 'geometry',
    title: 'Variazione',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: [],
    autoplay: true,
    narration: phrases.join(' '),
    studioCues: phrases.map(anchor => ({ anchor })),
    geometryStudio,
  };
}

function visible(root: VectorNode, className: string) {
  return [...descendants(root)].filter(node => node.hasClass(className) && isVisible(node));
}

test.each([
  { layout: 'ring', crowded: false },
  { layout: 'layered', crowded: true },
  { layout: 'force', crowded: true },
] as const)('the phone gate judges the $layout graph by actual clearance', ({
  layout,
  crowded,
}) => {
  const graph = scene(
    {
      id: 'graph',
      spec: {
        title: 'Cammino',
        layout,
        nodes: ['A', 'B', 'C'].map(id => ({ id, label: id })),
        edges: [
          { from: 'A', to: 'B', weight: 5, directed: true },
          { from: 'B', to: 'C', directed: true },
        ],
        algorithm: { kind: 'dijkstra', start: 'A', target: 'C' },
        beats: [{ at: 'b1', event: 'relax:B:C' }],
      },
    },
    ['Passiamo da B a C e confrontiamo la distanza totale.']
  );
  expect(findGeometryProblems(graph)).toEqual([]);
  const checks = checkAlgorithmGeometry(graph, readerStudioViewports.phone);
  expect(checks.some(check => check === 'min-gap' || check === 'label-placement')).toBe(crowded);
});

test('the 500 to 6 sine comparison from review is rejected in a narrow phone panel', () => {
  const plot = scene(
    {
      id: 'function-plot',
      spec: {
        family: 'sine',
        xRange: [0, 1],
        yRange: [-2, 2],
        keyframes: [
          { at: 'b1', params: { amplitude: 1, frequency: 500, phase: 0 } },
          { at: 'b2', params: { amplitude: 1, frequency: 6, phase: 0 } },
        ],
      },
    },
    [
      'Vediamo una sinusoide che oscilla molto fitta.',
      'Adesso la frequenza scende e il periodo aumenta.',
    ]
  );
  expect(findGeometryProblems(plot)).toEqual([]);
  expect(checkAlgorithmGeometry(plot, { width: 318, height: 220 })).toEqual(
    expect.arrayContaining(['overlap', 'min-gap'])
  );
});

test('the plane schema accepts short symbolic names and rejects a sentence as a beat label', () => {
  const spec = {
    title: 'Punto mobile',
    x: [-5, 5],
    y: [-3, 3],
    parameters: { offset: -2 },
    layers: [{ id: 'point', type: 'point', name: 'Punto iniziale', at: ['offset', 0] }],
  };
  const beat = { at: 'b1', focus: ['point'], set: { offset: 2 }, callout: true };
  for (const label of ['P₁', 'A′']) {
    expect(PlaneSpecSchema.safeParse({ ...spec, beats: [{ ...beat, label }] }).success).toBe(true);
  }
  expect(
    PlaneSpecSchema.safeParse({ ...spec, beats: [{ ...beat, label: 'Passa qui' }] }).success
  ).toBe(false);
});

test('a symbolic beat label leaves the Snell callout tied to the ray state', () => {
  const example = scene(
    {
      id: 'plane',
      spec: {
        title: 'Rifrazione',
        x: [-4, 4],
        y: [-3, 3],
        parameters: { incidence: 20 },
        layers: [{ id: 'ray', type: 'snell', n1: 1.5, n2: 1, angle: 'incidence' }],
        beats: [
          { at: 'b1', focus: ['ray'], callout: true, label: 'R' },
          { at: 'b2', focus: ['ray'], callout: true, label: 'R', set: { incidence: 55 } },
        ],
      },
    },
    ['Mostriamo il raggio rifratto.', 'Aumentiamo l’angolo di incidenza.']
  );
  const layout = buildAlgorithmLayout(example);
  function captionAt(ms: number) {
    layout.seek(ms, true);
    return visible(layout.surface, 'callout').flatMap(node =>
      [...descendants(node)].filter(child => child.tag === 'text').map(child => child.textContent)
    );
  }
  expect(captionAt(0)).toEqual([planeCopy.away]);
  expect(captionAt(layout.durationMs)).toEqual([planeCopy.total]);
});

test.each([
  undefined,
  ['wave'],
])('plane focus makes the target visible and rewinds to the earlier view (show %j)', show => {
  const example = scene(
    {
      id: 'plane',
      spec: {
        title: 'Il raggio ruota',
        x: [-1.3, 3],
        y: [-1.25, 1.25],
        grid: false,
        parameters: { theta: 45 },
        layers: [
          { id: 'wave', type: 'unit-circle-wave', angle: 'theta', waveStart: 1.5 },
          { id: 'B', type: 'point', name: 'B', at: [2.6, 1] },
        ],
        beats: [
          { at: 'b1', focus: ['wave'], show: ['wave'] },
          { at: 'b2', focus: ['B'], show, callout: true, set: { theta: 90 } },
        ],
      },
    },
    ['Portiamo il raggio a quarantacinque gradi.', 'Poi mostriamo il punto B.']
  );
  expect(findGeometryProblems(example)).toEqual([]);
  const layout = buildAlgorithmLayout(example, readerStudioViewports.phone);
  const point = [...descendants(layout.surface)].find(node => node.attrs['data-layer'] === 'B');
  assert(point);
  for (const reduced of [false, true]) {
    layout.seek(layout.durationMs, reduced);
    expect(point.children.some(node => node.tag === 'circle' && isVisible(node))).toBe(true);
    expect(visible(layout.surface, 'callout')).toHaveLength(1);
    layout.seek(0, reduced);
    expect(isVisible(point)).toBe(false);
  }
});

test.each([false, true])('a comparison needs shared time inside its active phase (%s)', phased => {
  const example = scene(
    {
      id: 'trajectories',
      spec: {
        title: 'Confronto',
        xLabel: 'Tempo',
        yLabel: 'Velocità',
        series: [
          {
            name: 'A',
            points: [
              [0, 0.2],
              [0.1, 0.25],
              [0.3, 0.3],
            ],
          },
          {
            name: 'B',
            points: [
              [phased ? 0.1 : 0.6, 0.65],
              [0.8, 0.7],
              [1, 0.75],
            ],
          },
        ],
        phases: [{ label: 'Fase', start: 0.35, end: 0.65 }],
        beats: [
          ...(phased ? [{ at: 'b1', action: 'phase' as const, target: 'Fase' }] : []),
          { at: phased ? 'b2' : 'b1', action: 'compare', target: ['A', 'B'] },
        ],
      },
    },
    phased ? ['Entriamo nella fase.', 'Ora confrontiamo le serie.'] : ['Confrontiamo le serie.']
  );
  expect(findGeometryProblems(example)).toEqual([
    'Compared series must overlap in the active phase or plot',
  ]);
});

test.each([
  false,
  true,
])('trajectory endpoint labels track arrival and rewind (reduced=%s)', reduced => {
  const example = scene(
    {
      id: 'trajectories',
      spec: {
        title: 'Andamenti',
        xLabel: 'Tempo',
        yLabel: 'Velocità',
        series: [
          {
            name: 'A',
            points: [
              [0, 0.2],
              [0.25, 0.2],
              [0.5, 0.25],
            ],
          },
          {
            name: 'B',
            points: [
              [0, 0.6],
              [0.75, 0.65],
              [1, 0.7],
            ],
          },
        ],
        beats: [{ at: 'b1', action: 'reveal', target: 'A' }],
      },
    },
    ['Ora osserviamo come sale e poi scende la velocità.']
  );
  const layout = buildAlgorithmLayout(
    { ...example, durationMs: 2400 },
    readerStudioViewports.phone
  );
  function labelsAt(ms: number) {
    layout.seek(ms, reduced);
    return visible(layout.surface, 'series-label').map(label => label.textContent);
  }
  const midpoint = layout.durationMs / 2;
  const arrival = reduced ? midpoint / 2 : midpoint;
  expect(labelsAt(arrival - 1)).toEqual([]);
  expect(labelsAt(arrival)).toEqual(['A']);
  if (reduced) expect(labelsAt(1800)).toEqual(['A', 'B']);
  expect(labelsAt(layout.durationMs)).toEqual(['A', 'B']);
  expect(labelsAt(arrival)).toEqual(['A']);
  expect(labelsAt(arrival - 1)).toEqual([]);
});

test('the label is visible when a single trajectory finishes at the playback deadline', () => {
  const example = scene(
    {
      id: 'trajectories',
      spec: {
        title: 'Variazione',
        xLabel: 'Tempo',
        yLabel: 'Velocità',
        series: [
          {
            name: 'A',
            points: [
              [0, 0.2],
              [0.6, 0.75],
              [1, 0.55],
            ],
          },
        ],
        beats: [{ at: 'b1', action: 'reveal', target: 'A' }],
      },
    },
    ['La velocità ora cambia.']
  );
  const layout = buildAlgorithmLayout(example, readerStudioViewports.phone);
  layout.seek(layout.durationMs);
  expect(visible(layout.surface, 'series-label').map(label => label.textContent)).toEqual(['A']);
});

test.each([
  'bfs',
  'dijkstra',
] as const)('%s reaches an opening visit:C cue within 450 ms after its prerequisites', kind => {
  const root = new VectorNode('root');
  root.data.durationMs = '4500';
  const spec = GraphSpecSchema.parse({
    title: 'Visita del grafo',
    nodes: ['A', 'B', 'C'].map(id => ({ id, label: id })),
    edges: [
      { from: 'A', to: 'B', weight: 1 },
      { from: 'B', to: 'C', weight: 1 },
    ],
    algorithm: { kind, start: 'A', ...(kind === 'dijkstra' ? { target: 'C' } : {}) },
    beats: [{ event: 'visit:C' }, { event: 'done' }],
  });
  const motion = buildGraph(spec, root, [0, 3000]);
  const visited = new Set<unknown>();
  for (let ms = 0; ms <= 450; ms += 5) {
    motion.seek(ms / 1000);
    for (const node of descendants(root)) {
      if (
        node.attrs['data-state'] === 'active' &&
        (kind !== 'dijkstra' || node.attrs['data-settled'] === 'true')
      ) {
        visited.add(node.attrs['data-node']);
      }
    }
  }
  expect([...visited]).toEqual(['A', 'B', 'C']);
  motion.seek(0.45, true);
  expect(visible(root, 'callout')).toHaveLength(1);
});

test('an optics medium can carry its name without concealing marks or colliding with text', () => {
  const optics = scene(
    {
      id: 'plane',
      spec: PlaneSpecSchema.parse({
        title: 'Rifrazione',
        x: [-2, 2],
        y: [-2, 2],
        grid: false,
        layers: [
          {
            id: 'ray',
            type: 'snell',
            n1: 1,
            n2: 1.33,
            angle: 45,
            media: [
              { index: 1, name: 'Aria' },
              { index: 1.33, name: 'Acqua' },
            ],
          },
        ],
        beats: [{ focus: ['ray'] }],
      }),
    },
    ['Il raggio attraversa la superficie tra aria e acqua.']
  );
  const stage = readerStudioViewports.desktop;
  const layout = buildAlgorithmLayout(optics, stage);
  layout.seek(0);
  expect(visible(layout.surface, 'plane-label').map(node => node.textContent)).toContain(
    'Acqua · n₂ = 1,33'
  );
  const checks = checkAlgorithmGeometry(optics, stage);
  expect(checks).not.toContain('overlap');
  expect(checks).not.toContain('min-gap');
  expect(checks).toContain('dead-stage');

  const anchor =
    'Il raggio entra in Acqua · n₂ = 1,33 e cambia direzione inclinando la traiettoria.';
  const holds = {
    ...optics,
    narration: anchor,
    studioCues: [{ anchor, hold: 'Acqua · n₂ = 1,33' }],
  };
  expect(checkAlgorithmGeometry(holds, stage)).not.toContain('dead-stage');
  const heldLayout = buildAlgorithmLayout(holds, stage);
  heldLayout.seek(500);
  expect(
    visible(heldLayout.surface, 'plane-label').find(node => node.data.studioHold)
  ).toHaveProperty('textContent', 'Acqua · n₂ = 1,33');
  expect(
    checkAlgorithmGeometry(
      {
        ...holds,
        studioCues: [{ anchor, hold: 'Aria · n₁ = 1' }],
      },
      stage
    )
  ).toContain('dead-stage');
  expect(
    checkAlgorithmGeometry(
      {
        ...holds,
        studioCues: [{ anchor, hold: 'traiettoria' }],
      },
      stage
    )
  ).toContain('dead-stage');
});

test('a vertex badge stays clear of the curve and axes as a parabola turns', () => {
  const plot = scene(
    {
      id: 'function-plot',
      spec: {
        family: 'quadratic',
        xRange: [-4, 4],
        yRange: [-5, 6],
        features: ['vertex'],
        keyframes: [
          { at: 'b1', params: { a: 1, b: 0, c: 0 } },
          { at: 'b2', params: { a: -1, b: 0, c: 0 } },
        ],
      },
    },
    ['La parabola apre verso l’alto.', 'La concavità adesso si inverte.']
  );
  expect(checkAlgorithmGeometry(plot, readerStudioViewports.desktop)).toEqual([]);
});

test.each([
  false,
  true,
])('a brief graph comparison shows its winner and explanation (reduced=%s)', reduced => {
  const graph = scene(
    {
      id: 'graph',
      spec: GraphSpecSchema.parse({
        title: 'Gerarchia',
        nodes: [
          { id: 'a', label: 'Legge' },
          { id: 'b', label: 'Regolamento' },
        ],
        edges: [{ from: 'a', to: 'b', directed: true }],
        beats: [
          {
            at: 'b1',
            event: 'compare',
            nodes: ['a', 'b'],
            winner: 'a',
            reason: 'Prevale la legge',
          },
          { at: 'b2', event: 'reveal', nodes: ['a', 'b'] },
        ],
      }),
    },
    ['Confronto.', 'Riprendiamo la gerarchia.']
  );
  const layout = buildAlgorithmLayout(graph, readerStudioViewports.desktop);
  for (const time of reduced ? [0, 249] : [180]) {
    layout.seek(time, reduced);
    expect(visible(layout.surface, 'success-pill')).toHaveLength(1);
    expect(visible(layout.surface, 'graph-reason').map(node => node.textContent)).toEqual([
      'Prevale la legge',
    ]);
  }
  layout.seek(250, reduced);
  expect(visible(layout.surface, 'graph-reason')).toHaveLength(0);
});

test('an animated region counts as motion when its defining curves are hidden', () => {
  const plane = scene(
    {
      id: 'plane',
      spec: PlaneSpecSchema.parse({
        title: 'Area',
        x: [-2, 2],
        y: [-2, 2],
        grid: false,
        parameters: { height: 1 },
        layers: [
          { id: 'upper', type: 'line', form: { m: 0, b: 'height' } },
          { id: 'lower', type: 'line', form: { m: 0, b: 0 } },
          { id: 'fill', type: 'region', between: ['upper', 'lower'], where: 'above' },
        ],
        beats: [{ at: 'b1', focus: ['fill'], show: ['fill'], set: { height: 2 } }],
      }),
    },
    ['L’area colorata si espande.']
  );
  expect(checkAlgorithmGeometry(plane, readerStudioViewports.desktop)).toEqual([]);
});
