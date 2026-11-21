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
  'ring',
  'layered',
  'force',
] as const)('the %s implicit-cost graph from review is rejected at the phone stage', layout => {
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
  expect(checkAlgorithmGeometry(graph, readerStudioViewports.phone)).toContain('min-gap');
});

test('the 500 to 6 sine comparison from review is rejected at the phone stage', () => {
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
  expect(checkAlgorithmGeometry(plot, readerStudioViewports.phone)).toEqual(['overlap', 'min-gap']);
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
  expect(PlaneSpecSchema.safeParse({ ...spec, beats: [{ ...beat, label: 'P₁' }] }).success).toBe(
    true
  );
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
