import { checkAlgorithmGeometry } from '@shared/lessonStudios/algorithmLayout';
import { chart } from '@shared/lessonStudios/chart';
import { readerStudioViewports, studioViewportScale } from '@shared/lessonStudios/chartDimensions';
import { boxDistance, isVisible, vectorBounds } from '@shared/lessonStudios/vectorBounds';
import { descendants, VectorNode } from '@shared/lessonStudios/vectorScene';
import { assert, expect, test } from 'vitest';
import {
  decodeGeometryStudioDraft,
  decodeStudioDraft,
} from '../../../src/services/lessonScenes/lessonStudioSelection';

test.each(
  Object.entries(readerStudioViewports)
)('%s chart keeps visible text at 14 CSS px or more and thins ticks without removing grid marks', (_reader, viewport) => {
  const root = new VectorNode('root', {}, viewport);
  const { surface } = chart(root, [-12500, 12500], [-4, 4], 'x', 'y', true);
  const scale = studioViewportScale(viewport);
  const ticks = [...descendants(surface)].filter(node => node.hasClass('tick'));
  const visible = ticks.filter(isVisible);
  expect(visible.length).toBeGreaterThan(2);
  expect(visible.length).toBeLessThan(ticks.length);
  expect(visible.some(tick => tick.textContent.endsWith('K'))).toBe(true);
  const boxes = visible.flatMap(node => vectorBounds(node));
  for (const node of visible) expect((node.label?.size ?? 0) * scale).toBeGreaterThanOrEqual(14);
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1))
      expect(boxDistance(box, other) * scale).toBeGreaterThanOrEqual(8);
  }
  expect([...descendants(surface)].filter(node => node.parent?.hasClass('grid'))).toHaveLength(
    ticks.length
  );
});

const resizeScenes = [
  {
    studio: 'array-algorithm',
    narration: ['Confrontiamo tre e quattro.', 'Il passaggio senza scambi conferma l’ordine.'],
    draft: {
      type: 'algorithm',
      studio: 'array-algorithm',
      spec: { algorithm: 'bubble', input: [3, 4], callouts: [] },
    },
  },
  {
    studio: 'function-plot',
    narration: [
      'Il coefficiente positivo apre la parabola verso l’alto.',
      'Quando diventa negativo, la concavità si inverte.',
    ],
    draft: {
      type: 'geometry',
      geometryStudio: {
        id: 'function-plot',
        spec: {
          family: 'quadratic',
          xRange: [-2, 2],
          yRange: [-4, 4],
          keyframes: [
            { at: 'b1', params: { a: 1, b: 0, c: 0 } },
            { at: 'b2', params: { a: -1, b: 0, c: 0 } },
          ],
        },
      },
    },
  },
  {
    studio: 'heap',
    narration: [
      'Per prima cosa sistemiamo i nodi nello heap.',
      'Il massimo arriva in cima allo heap.',
      'Spostiamo il massimo alla fine della lista.',
      'Ripetiamo finché la lista è ordinata.',
    ],
    draft: {
      type: 'algorithm',
      studio: 'heap',
      spec: {
        input: [4, 3],
        operation: 'sort',
        beats: ['start', 'heapified', 'extract#1', 'done'].map((event, index) => ({
          at: index + 1,
          event,
        })),
      },
    },
  },
  {
    studio: 'graph',
    narration: [
      'Partiamo da A e prendiamo i suoi vicini.',
      'Visitiamo B e C nello stesso livello.',
    ],
    draft: {
      type: 'geometry',
      geometryStudio: {
        id: 'graph',
        spec: {
          title: 'Visita in ampiezza',
          layout: 'ring',
          nodes: ['A', 'B', 'C'].map(id => ({ id, label: id })),
          edges: [
            { from: 'A', to: 'B', directed: true },
            { from: 'A', to: 'C', directed: true },
          ],
          algorithm: { kind: 'bfs', start: 'A' },
          beats: [
            { at: 'b1', event: 'start' },
            { at: 'b2', event: 'done' },
          ],
        },
      },
    },
  },
  {
    studio: 'plane',
    narration: ['Portiamo il raggio a quarantacinque gradi.', 'Poi lo portiamo a novanta gradi.'],
    draft: {
      type: 'geometry',
      geometryStudio: {
        id: 'plane',
        spec: {
          title: 'Il raggio ruota',
          x: [-1.3, 3],
          y: [-1.25, 1.25],
          grid: false,
          parameters: { theta: 45 },
          layers: [{ id: 'wave', type: 'unit-circle-wave', angle: 'theta', waveStart: 1.5 }],
          beats: [
            { at: 'b1', focus: ['wave'] },
            { at: 'b2', focus: ['wave'], set: { theta: 90 } },
          ],
        },
      },
    },
  },
  {
    studio: 'trajectories',
    narration: [
      'All’inizio la velocità sale a poco a poco.',
      'Poi scende e torna al valore iniziale.',
    ],
    draft: {
      type: 'geometry',
      geometryStudio: {
        id: 'trajectories',
        spec: {
          title: 'La velocità cambia',
          xLabel: 'Tempo',
          yLabel: 'Velocità',
          series: [
            {
              name: 'Velocità',
              points: [
                [0, 0],
                [0.6, 0.75],
                [1, 0],
              ],
            },
          ],
          beats: [{ at: 'b1', action: 'reveal', target: 'Velocità' }],
        },
      },
    },
  },
];

test.each(resizeScenes)('$studio passes the actual-size gate on desktop and phone', ({
  narration,
  draft,
}) => {
  const decode = draft.type === 'algorithm' ? decodeStudioDraft : decodeGeometryStudioDraft;
  const scene = decode(draft, narration.join(' '), narration);
  assert(scene);
  for (const viewport of Object.values(readerStudioViewports))
    expect(checkAlgorithmGeometry(scene, viewport)).toEqual([]);
});

test('a graph goes to the layout fallback when fitting would truncate a required node name', () => {
  const graph = resizeScenes.find(candidate => candidate.studio === 'graph');
  assert(graph?.draft.geometryStudio);
  const { narration, draft } = graph;
  const scene = decodeGeometryStudioDraft(
    {
      ...draft,
      geometryStudio: {
        ...draft.geometryStudio,
        spec: {
          ...draft.geometryStudio.spec,
          nodes: ['A', 'B', 'C'].map(id => ({
            id,
            label:
              id === 'A' ? 'Punto in cui si incontrano il sentiero e la strada principale' : id,
          })),
        },
      },
    },
    narration.join(' '),
    narration
  );
  assert(scene);
  expect(checkAlgorithmGeometry(scene, readerStudioViewports.phone)).toContain('label-placement');
});

test('visiting an isolated graph node counts as activity when its readout changes in place', () => {
  const phrases = [
    'La coda contiene soltanto A.',
    'Visitiamo A e svuotiamo la coda.',
    'La visita in ampiezza termina.',
  ];
  const scene = decodeGeometryStudioDraft(
    {
      type: 'geometry',
      geometryStudio: {
        id: 'graph',
        spec: {
          title: 'Visita in ampiezza',
          nodes: [{ id: 'A', label: 'A' }],
          edges: [],
          algorithm: { kind: 'bfs', start: 'A' },
          beats: ['start', 'visit:A', 'done'].map((event, index) => ({
            at: `b${index + 1}`,
            event,
          })),
        },
      },
    },
    phrases.join(' '),
    phrases
  );
  assert(scene);
  expect(checkAlgorithmGeometry(scene, readerStudioViewports.phone)).toEqual([]);
});
