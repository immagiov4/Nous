import { checkAlgorithmGeometry } from '@shared/lessonStudios/algorithmLayout';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { computeGraphTrace } from '@shared/lessonStudios/graphSpec';
import { assert, expect, test } from 'vitest';
import { geometrySelection } from '../../../src/services/lessonScenes/lessonStudioSelection';
import { planStudioScene } from '../../../src/services/lessonScenes/studioBeatPlanning';

test('Prim grows the reached set through cheapest crossing edges and keeps their true weights', () => {
  const scene = planStudioScene({
    type: 'geometry',
    geometryStudio: {
      id: 'graph',
      spec: {
        nodes: ['A', 'B', 'C', 'D'].map(id => ({ id, label: id })),
        edges: [
          { from: 'A', to: 'B', weight: 3 },
          { from: 'A', to: 'C', weight: 4 },
          { from: 'B', to: 'C', weight: 1 },
          { from: 'C', to: 'D', weight: 2 },
        ],
        algorithm: { kind: 'prim', start: 'A' },
      },
    },
    operandSources: [],
  });
  assert(scene?.type === 'geometry' && scene.geometryStudio.id === 'graph');
  const trace = computeGraphTrace(scene.geometryStudio.spec);
  expect(trace.flatMap(step => step.edge?.index ?? [])).toEqual([0, 2, 3]);
  expect(trace.at(-1)?.settled).toEqual(['A', 'B', 'C', 'D']);
  expect(scene.studioCues.flatMap(cue => cue.targets ?? [])).toEqual([
    'A',
    'edge:0',
    'edge:2',
    'edge:3',
  ]);
  expect(scene.studioCues.slice(1).map(cue => cue.anchor)).toEqual([
    'Aggiungiamo l’arco da A a B, di peso 3.',
    'Aggiungiamo l’arco da B a C, di peso 1.',
    'Aggiungiamo l’arco da C a D, di peso 2.',
  ]);
  expect(
    checkAlgorithmGeometry(scene, readerStudioViewports.desktop, { requireBeatSync: true })
  ).toEqual([]);
});

test('a disconnected graph is rejected rather than described as a spanning tree', () => {
  const scene = planStudioScene({
    type: 'geometry',
    geometryStudio: {
      id: 'graph',
      spec: {
        nodes: ['A', 'B', 'C'].map(id => ({ id, label: id })),
        edges: [{ from: 'A', to: 'B', weight: 1 }],
        algorithm: { kind: 'prim', start: 'A' },
      },
    },
    operandSources: [],
  });
  expect(scene).toBeUndefined();
});

test('Prim declares its chosen start when the lesson names none', () => {
  const graph = (start?: string) =>
    planStudioScene({
      type: 'geometry',
      geometryStudio: {
        id: 'graph',
        spec: {
          nodes: ['A', 'B'].map(id => ({ id, label: id })),
          edges: [{ from: 'A', to: 'B', weight: 1 }],
          algorithm: { kind: 'prim', start },
        },
      },
      operandSources: [],
    });
  const chosen = graph();
  const stated = graph('A');
  assert(chosen && stated);
  expect(chosen.studioCues[0].anchor).toBe('Scegliamo di partire da A.');
  expect(stated.studioCues[0].anchor).toBe('Partiamo da A.');
  expect(chosen.studioCues.slice(1)).toEqual(stated.studioCues.slice(1));
});

test('the frozen selection contract offers neither Prim nor computed plane mechanisms', () => {
  const allowed = (id: string) => id === 'graph' || id === 'plane';
  const current = geometrySelection(allowed, true);
  const frozen = geometrySelection(allowed, true, false);
  const examples = [
    { id: 'graph', spec: { algorithm: 'prim' } },
    { id: 'plane', spec: { form: 'compound-interest' } },
  ];
  for (const geometryStudio of examples) {
    const draft = { type: 'geometry', inputMode: 'example', geometryStudio, operandSources: [] };
    expect(current?.schema.safeParse(draft).success).toBe(true);
    expect(frozen?.schema.safeParse(draft).success).toBe(false);
  }
});

test.each(['bfs', 'dfs'] as const)('a new %s plan stops when it visits the stated target', kind => {
  const draft = {
    type: 'geometry',
    geometryStudio: {
      id: 'graph',
      spec: {
        nodes: ['A', 'B', 'C'].map(id => ({ id, label: id })),
        edges: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
        ],
        algorithm: { kind, start: 'A', target: 'B' },
      },
    },
    operandSources: [],
  };
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry' && scene.geometryStudio.id === 'graph');
  const { spec } = scene.geometryStudio;
  expect(computeGraphTrace(spec).at(-1)?.settled).toEqual(['A', 'B']);
  const storedAlgorithm = { kind, start: 'A', target: 'B' };
  expect(computeGraphTrace({ ...spec, algorithm: storedAlgorithm }).at(-1)?.settled).toEqual([
    'A',
    'B',
    'C',
  ]);
  const historicalScene = planStudioScene(draft, false);
  assert(historicalScene?.type === 'geometry' && historicalScene.geometryStudio.id === 'graph');
  expect(historicalScene.geometryStudio.spec.beats.map(beat => beat.event)).toContain('visit:C');
});

test.each(['bfs', 'dfs'] as const)('a bounded %s names the disconnected target', kind => {
  const draft = {
    type: 'geometry',
    geometryStudio: {
      id: 'graph',
      spec: {
        nodes: ['A', 'B', 'C'].map(id => ({ id, label: id })),
        edges: [{ from: 'A', to: 'B' }],
        algorithm: { kind, start: 'A', target: 'C' },
      },
    },
    operandSources: [],
  };
  const scene = planStudioScene(draft);
  assert(scene?.type === 'geometry' && scene.geometryStudio.id === 'graph');
  expect(scene.studioCues.at(-1)).toMatchObject({
    anchor: 'Il nodo C non è raggiungibile.',
    targets: ['C'],
  });
  expect(computeGraphTrace(scene.geometryStudio.spec).at(-1)?.settled).toEqual(['A', 'B']);
  expect(
    checkAlgorithmGeometry(scene, readerStudioViewports.desktop, { requireBeatSync: true })
  ).toEqual([]);
  expect(planStudioScene(draft, false)?.studioCues.at(-1)?.anchor).toBe('Visitiamo B.');
});
