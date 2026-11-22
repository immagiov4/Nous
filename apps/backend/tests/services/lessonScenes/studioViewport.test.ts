import { checkAlgorithmGeometry } from '@shared/lessonStudios/algorithmLayout';
import { type ArraySpec, arrayTrace } from '@shared/lessonStudios/arrayAlgorithm';
import { planArrayBeats } from '@shared/lessonStudios/arrayBeatPlan';
import { chart } from '@shared/lessonStudios/chart';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { boxDistance, isVisible, vectorBounds } from '@shared/lessonStudios/vectorBounds';
import { descendants, VectorNode } from '@shared/lessonStudios/vectorScene';
import { assert, expect, test } from 'vitest';
import {
  checkStudioOperands,
  decodeGeometryStudioDraft,
  decodeStudioDraft,
} from '../../../src/services/lessonScenes/lessonStudioSelection';
import { planStudioScene } from '../../../src/services/lessonScenes/studioBeatPlanning';

test.each([
  'bubble',
  'insertion',
  'selection',
] as const)('the %s pass describes what the trace guarantees', algorithm => {
  const spec: ArraySpec = { algorithm, input: [3, 2, 1], callouts: [] };
  const trace = arrayTrace(spec);
  const passes = planArrayBeats(spec).filter(beat => beat.event.startsWith('pass-end'));
  expect(passes).toHaveLength(2);
  for (const beat of passes) {
    const frame = trace.find(step => step.aliases.includes(beat.event));
    assert(frame);
    const ids = beat.targets.map(Number);
    const shown = ids.map(id => spec.input[id]);
    if (algorithm === 'insertion') {
      expect(shown).toEqual(frame.order.slice(0, ids.length).map(id => spec.input[id]));
      expect(shown).toEqual([...shown].sort((a, b) => a - b));
      expect(beat.sentence).toBe(`La parte iniziale è ordinata: ${shown.join(', ')}.`);
    } else {
      const end = trace.at(-1)?.order;
      expect(ids.every(id => frame.order.indexOf(id) === end?.indexOf(id))).toBe(true);
      expect(beat.sentence).toBe(`Sono in posizione definitiva: ${shown.join(', ')}.`);
    }
  }
});

test.each([
  [3, 'Abbiamo trovato 3.'],
  [2, '2 non compare nella lista.'],
] as const)('binary search reports the actual result for %s', (target, result) => {
  const spec: ArraySpec = { algorithm: 'binary-search', input: [1, 3, 5], target, callouts: [] };
  expect(planArrayBeats(spec).at(-1)?.sentence).toBe(result);
});

const numericGraphPassage =
  'Applichiamo Dijkstra. Partiamo dal nodo 1. La destinazione è il nodo 2. L’arco 1 → 2, peso 3.';
const graphFields = 'geometryStudio.spec';

test.each([
  { quote: undefined, field: undefined },
  { quote: 'L’arco 1 → 2, peso 3', field: 'edges.0', weight: 2 },
  { quote: 'Applichiamo Dijkstra', field: 'algorithm.kind', kind: 'bfs' },
  { quote: 'L’arco 1 → 2, peso 3', field: 'algorithm.start' },
  { quote: 'Partiamo dal nodo 1', field: 'algorithm.target' },
  { quote: undefined, field: 'nodes.2', isolated: true },
  { quote: undefined, field: undefined, isolated: true, nodeSource: 'Il nodo isolato 3' },
  { quote: 'Partiamo dal nodo 1', field: 'nodes.2', isolated: true, nodeLabel: '1' },
] as const)('grounds numeric node labels, weight, procedure and roles ($field)', ({
  quote,
  field,
  ...change
}) => {
  const draft = {
    type: 'geometry',
    geometryStudio: {
      id: 'graph',
      spec: {
        title: 'Cammino',
        nodes: [
          { id: 'one', label: '1' },
          { id: 'two', label: '2' },
          ...('isolated' in change
            ? [{ id: 'three', label: 'nodeLabel' in change ? change.nodeLabel : '3' }]
            : []),
        ],
        edges: [
          {
            from: 'one',
            to: 'two',
            weight: 'weight' in change ? change.weight : 3,
            directed: true,
          },
        ],
        algorithm: {
          kind: 'kind' in change ? change.kind : 'dijkstra',
          start: 'one',
          target: 'two',
        },
      },
    },
    operandSources: [
      { field: 'algorithm.kind', quote: 'Applichiamo Dijkstra' },
      { field: 'algorithm.start', quote: 'Partiamo dal nodo 1' },
      { field: 'algorithm.target', quote: 'La destinazione è il nodo 2' },
      { field: 'edges.0', quote: 'L’arco 1 → 2, peso 3' },
      ...('nodeSource' in change || 'nodeLabel' in change
        ? [{ field: 'nodes.2', quote: 'nodeSource' in change ? change.nodeSource : quote }]
        : []),
    ].map(source => ({
      field: `${graphFields}.${source.field}`,
      quote: source.field === field ? quote : source.quote,
    })),
  };
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry');
  const passage =
    'nodeSource' in change
      ? `${numericGraphPassage} ${change.nodeSource} resta scollegato.`
      : numericGraphPassage;
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBe(
    field ? `${graphFields}.${field}` : undefined
  );
});

test('introduces a Dijkstra example for a procedure, but preserves a stated link', () => {
  const draft = {
    type: 'geometry',
    inputMode: 'example',
    geometryStudio: { id: 'graph', spec: { algorithm: 'dijkstra' } },
    operandSources: [{ field: 'geometryStudio.spec.algorithm', quote: 'Dijkstra' }],
  };
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry');
  const passage = 'Dijkstra trova i cammini minimi con pesi non negativi.';
  const grounded = checkStudioOperands(scene, draft, [], passage, true);
  expect(grounded.rejectedField).toBeUndefined();
  expect(scene.narration.slice(0, grounded.operandEvidence[1].end)).toMatch(
    /^Per esempio, da A a D: A–B \(2\)/u
  );
  expect(
    checkStudioOperands(scene, draft, [], `${passage} Usiamo X → Y.`, true).rejectedField
  ).toBe('geometryStudio.spec.edges');
  expect(
    checkStudioOperands(scene, draft, [], `${passage} Da S a T ha lunghezza sette.`, true)
      .rejectedField
  ).toBe('geometryStudio.spec.edges');
  expect(checkStudioOperands(scene, draft, [], 'Non usiamo Dijkstra.', true).rejectedField).toBe(
    'geometryStudio.spec.algorithm'
  );
});

test('does not plan concrete graphs with annotations outside the extraction contract', () => {
  const nodes = [
    { id: 'A', label: 'A' },
    { id: 'B', label: 'B' },
  ];
  const edge = { from: 'A', to: 'B', directed: true, weight: 3 };
  const spec = { title: 'Cammino', nodes, edges: [edge] };
  const plan = (graph: unknown) =>
    planStudioScene({
      type: 'geometry',
      geometryStudio: { id: 'graph', spec: graph },
      operandSources: [{ field: 'geometryStudio.spec.edges.0', quote: 'L’arco A → B, peso 3' }],
    });
  expect(plan(spec)?.type).toBe('geometry');
  for (const annotation of [
    { relation: 'containment' },
    { nodes: [{ ...nodes[0], group: 'Root' }, nodes[1]] },
    { edges: [{ ...edge, label: 'Pedaggio' }] },
  ]) {
    expect(plan({ ...spec, ...annotation })).toBeUndefined();
  }
});

test('introduces a search target only when the lesson leaves the target unspecified', () => {
  const draft = {
    type: 'algorithm',
    studio: 'array-algorithm',
    inputMode: 'example',
    spec: { algorithm: 'binary-search' },
    operandSources: [{ field: 'spec.algorithm', quote: 'ricerca binaria' }],
  };
  const scene = planStudioScene(draft);
  assert(scene?.type === 'algorithm');
  const passage = 'La ricerca binaria divide il tratto in 2 parti.';
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
  expect(scene.studioCues[0].anchor).toMatch(/^Per esempio, cerchiamo 7 in 1, 3, 5, 7, 9\./u);
  for (const target of ['Il valore da cercare è 12.', 'La chiave di ricerca è dodici.']) {
    expect(checkStudioOperands(scene, draft, [], `${passage} ${target}`, true).rejectedField).toBe(
      'spec.input'
    );
  }
});

test('keeps the dimensions stated in words instead of using an illustrative floor', () => {
  const draft = {
    type: 'geometry',
    inputMode: 'example',
    geometryStudio: { id: 'plane', spec: { construction: 'perspective' } },
    operandSources: [{ field: 'geometryStudio.spec.construction', quote: 'punto di fuga' }],
  };
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry');
  const passage = 'Per disegnare il pavimento in un’immagine 2D, scegliamo un punto di fuga.';
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
  expect(
    checkAlgorithmGeometry(scene, readerStudioViewports.phone, { requireBeatSync: true })
  ).toEqual([]);
  for (const measurement of [
    'Dividiamo il bordo in tre segmenti e tracciamo due file di piastrelle.',
    'La griglia misura 4x6.',
    'La griglia misura 4x6cm.',
    'La griglia misura 4 x6.',
    String.raw`La griglia misura \(4 \times 6\).`,
    'Il segmento misura 4cm.',
    'Usiamo una griglia quadrata di lato 7.',
  ]) {
    expect(
      checkStudioOperands(scene, draft, [], `${passage} ${measurement}`, true).rejectedField
    ).toBe('geometryStudio.spec.construction');
  }
});

test.each([
  'y = a·x²',
  'y = a\\cdot x^2',
  String.raw`\(y = a \cdot x^{2}\)`,
])('accepts a symbolic parabola %s and rejects replacing numeric coefficients', formula => {
  const draft = {
    type: 'geometry',
    inputMode: 'example',
    geometryStudio: { id: 'function-plot', spec: { form: 'quadratic-scale' } },
    operandSources: [{ field: 'geometryStudio.spec.formula', quote: formula }],
  };
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry');
  const passage = `La forma ${formula} mostra come cambia l’apertura.`;
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
  for (const stated of [
    ' Il coefficiente $a$ = 7 cambia l’apertura.',
    ' Il coefficiente a è sette.',
    ' Il parametro a assume i valori tre e zero virgola tre.',
    ' Con y = 7x² la parabola è stretta, mentre y = 0,3x² la allarga.',
  ]) {
    expect(checkStudioOperands(scene, draft, [], `${passage}${stated}`, true).rejectedField).toBe(
      'geometryStudio.spec.values'
    );
  }
});

test('grounds authored LaTeX scale assignments and preserves both source values', () => {
  const formula = String.raw`\[y = a \cdot x^{2}\]`;
  const assignments = [String.raw`\(a = 3\)`, String.raw`\(a = 0,3\)`];
  const passage = `${formula}\nCon ${assignments[0]} la parabola è stretta. Con ${assignments[1]} si allarga.`;
  const draft = {
    type: 'geometry',
    geometryStudio: { id: 'function-plot', spec: { form: 'quadratic-scale', values: [3, 0.3] } },
    operandSources: [
      { field: 'geometryStudio.spec.formula', quote: formula },
      ...assignments.map((quote, index) => ({
        field: `geometryStudio.spec.values.${index}`,
        quote,
      })),
    ],
  };
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry');
  expect(checkStudioOperands(scene, draft, [], passage, true).rejectedField).toBeUndefined();
});

test('accepts the first named graph edge when its highlight arrives within the cue window', () => {
  const scene = planStudioScene({
    type: 'geometry',
    geometryStudio: {
      id: 'graph',
      spec: {
        title: 'Passi',
        nodes: ['A', 'B', 'C'].map(label => ({ id: label, label })),
        edges: [
          { from: 'A', to: 'B', directed: true },
          { from: 'B', to: 'C', directed: true },
        ],
      },
    },
    operandSources: [],
  });
  assert(scene?.type === 'geometry');
  const stage = readerStudioViewports.desktop;
  expect(checkAlgorithmGeometry(scene, stage, { requireBeatSync: true })).toEqual([]);
});

test('rejects an unrelated visible array tile at the first comparison', () => {
  const scene = planStudioScene({
    type: 'algorithm',
    studio: 'array-algorithm',
    spec: { algorithm: 'bubble', input: [3, 4, 5] },
    operandSources: [],
  });
  assert(scene?.type === 'algorithm');
  const stage = readerStudioViewports.desktop;
  expect(checkAlgorithmGeometry(scene, stage, { requireBeatSync: true })).toEqual([]);
  const [opening, ...rest] = scene.studioCues;
  const wrongTarget = { ...scene, studioCues: [{ ...opening, targets: ['2'] }, ...rest] };
  expect(checkAlgorithmGeometry(wrongTarget, stage, { requireBeatSync: true })).toContain(
    'dead-stage'
  );
});

test('a changing plot fails motion validation when its sentence points to another element', () => {
  const scene = planStudioScene({
    type: 'geometry',
    geometryStudio: {
      id: 'function-plot',
      spec: {
        family: 'quadratic',
        xRange: [-2, 2],
        yRange: [-4, 4],
        keyframes: [{ params: { a: 1, b: 0, c: 0 } }, { params: { a: -1, b: 0, c: 0 } }],
      },
    },
    operandSources: [],
  });
  assert(scene?.type === 'geometry');
  const stage = readerStudioViewports.desktop;
  expect(checkAlgorithmGeometry(scene, stage, { requireBeatSync: true })).toEqual([]);
  const wrongTarget = {
    ...scene,
    studioCues: [scene.studioCues[0], { ...scene.studioCues[1], targets: ['unrelated'] }],
  };
  expect(checkAlgorithmGeometry(wrongTarget, stage, { requireBeatSync: true })).toContain(
    'dead-stage'
  );
});

test.each(
  Object.entries(readerStudioViewports)
)('%s chart keeps visible text at 14 CSS px or more and thins ticks without removing grid marks', (reader, viewport) => {
  const root = new VectorNode('root', {}, viewport);
  const { surface } = chart(root, [-12500, 12500], [-4, 4], 'x', 'y', true);
  const ticks = [...descendants(surface)].filter(node => node.hasClass('tick'));
  const visible = ticks.filter(isVisible);
  expect(visible.length).toBeGreaterThan(2);
  if (reader === 'phone') {
    expect(visible.length).toBeLessThan(ticks.length);
    expect(visible.some(tick => tick.textContent.endsWith('K'))).toBe(true);
  }
  const boxes = visible.flatMap(node => vectorBounds(node));
  for (const node of visible) expect(node.label?.size ?? 0).toBeGreaterThanOrEqual(14);
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1))
      expect(boxDistance(box, other)).toBeGreaterThanOrEqual(8);
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
  expect(checkAlgorithmGeometry(scene, readerStudioViewports.phone)).toEqual(['label-placement']);
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
