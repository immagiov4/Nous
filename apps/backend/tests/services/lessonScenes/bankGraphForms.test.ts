import {
  buildAlgorithmLayout,
  checkAlgorithmGeometry,
} from '@shared/lessonStudios/algorithmLayout';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { computeGraphTrace } from '@shared/lessonStudios/graphSpec';
import { isVisible } from '@shared/lessonStudios/vectorBounds';
import { descendants } from '@shared/lessonStudios/vectorScene';
import { expect, test } from 'vitest';
import {
  checkStudioCandidate,
  checkStudioOperands,
} from '../../../src/services/lessonScenes/lessonStudioSelection';
import { planStudioScene } from '../../../src/services/lessonScenes/studioBeatPlanning';

const graphDraft = {
  type: 'geometry',
  geometryStudio: { id: 'graph', spec: { algorithm: 'kruskal' } },
  inputMode: 'example',
  operandSources: [{ field: 'geometryStudio.spec.algorithm', quote: 'algoritmo di Kruskal' }],
};

const extraViewports = [
  { width: 403, height: 204.72 },
  { width: 274, height: 139.19 },
  { width: 650, height: 330 },
  { width: 350, height: 178 },
];

test('Kruskal reveals each accepted edge and rejects the cycle before the final connection', async () => {
  const scene = planStudioScene(graphDraft);
  if (scene?.type !== 'geometry' || scene.geometryStudio.id !== 'graph')
    throw new Error('Expected a graph scene');
  const { spec } = scene.geometryStudio;
  expect(spec.beats.map(({ event }) => event)).toEqual([
    'start',
    'add:2',
    'add:0',
    'skip:1',
    'add:3',
  ]);
  expect(computeGraphTrace(spec).at(-1)?.tree).toEqual([2, 0, 3]);
  expect(scene.studioCues?.map(cue => cue.targets)).toEqual([
    ['A', 'B', 'C', 'D'],
    ['edge:2'],
    ['edge:0'],
    ['edge:1'],
    ['edge:3'],
  ]);
  const layout = buildAlgorithmLayout(scene, readerStudioViewports.desktop);
  const pulses = [...descendants(layout.surface)].filter(node => node.hasClass('graph-pulse'));
  layout.seek((layout.cues[3] + layout.cues[4]) / 2);
  expect(isVisible(pulses[1])).toBe(true);
  expect(pulses[1].attrs['stroke-dasharray']).not.toEqual(pulses[2].attrs['stroke-dasharray']);
  expect(pulses[1].attrs['stroke-linecap']).toBe('butt');
  layout.seek(layout.durationMs);
  expect(isVisible(pulses[1])).toBe(false);
  expect(isVisible(pulses[2])).toBe(true);
  expect(pulses[2].attrs['stroke-dashoffset']).toBe('0');
  const section =
    'Su un grafo non orientato, con l’algoritmo di Kruskal proviamo gli archi in ordine di peso, ma non aggiungiamo quelli che chiudono un ciclo.';
  const checks = await checkStudioCandidate(scene, graphDraft, [section], {
    section,
    decisionId: 'kruskal-example',
    requireCitations: true,
  });
  expect(checks.failedChecks).toEqual([]);
  for (const viewport of extraViewports)
    expect(checkAlgorithmGeometry(scene, viewport, { requireBeatSync: true })).toEqual([]);
});

test('a topological example outputs each task only after its dependencies', () => {
  const scene = planStudioScene({
    ...graphDraft,
    geometryStudio: { id: 'graph', spec: { algorithm: 'topo-sort' } },
    operandSources: [{ field: 'geometryStudio.spec.algorithm', quote: 'ordinamento topologico' }],
  });
  if (scene?.type !== 'geometry' || scene.geometryStudio.id !== 'graph')
    throw new Error('Expected a graph scene');
  const spec = scene.geometryStudio.spec;
  const steps = computeGraphTrace(spec);
  const order = steps.at(-1)?.settled ?? [];
  expect(new Set(order)).toEqual(new Set(spec.nodes.map(node => node.id)));
  expect(spec.edges.every(({ from, to }) => order.indexOf(from) < order.indexOf(to))).toBe(true);
  const layout = buildAlgorithmLayout(scene, readerStudioViewports.desktop);
  const vectors = [...descendants(layout.surface)];
  const readout = vectors.find(node => node.hasClass('graph-result'));
  const ready = vectors.find(node => node.hasClass('graph-hud'));
  for (const [index, step] of steps.slice(0, -1).entries()) {
    layout.seek((layout.cues[index] + (layout.cues[index + 1] ?? layout.durationMs)) / 2);
    expect(readout?.textContent.match(/\b[A-D]\b/gu) ?? []).toEqual(step.settled);
    expect(ready?.textContent.match(/\b[A-D]\b/gu) ?? []).toEqual(step.frontier);
    const cue = scene.studioCues?.[index];
    if (step.frontier.length) expect(cue?.anchor).toContain(step.frontier.join(', '));
  }
  for (const viewport of [...Object.values(readerStudioViewports), ...extraViewports])
    expect(checkAlgorithmGeometry(scene, viewport, { requireBeatSync: true })).toEqual([]);
});

test('a cited Kruskal cost order preserves every edge without inventing numeric costs', () => {
  const order = 'archi in ordine di costo: (B, C), (A, B); poi (A, C) e infine (C, D)';
  const section = `Per il grafo non orientato, ecco gli ${order}. Eseguiamo Kruskal.`;
  const nodes = ['A', 'B', 'C', 'D'].map(id => ({ id, label: id }));
  const edges = [
    { from: 'B', to: 'C' },
    { from: 'A', to: 'B' },
    { from: 'A', to: 'C' },
    { from: 'C', to: 'D' },
  ];
  const verify = (sequence: typeof edges, passage = section, quote = order) => {
    const draft = {
      type: 'geometry',
      geometryStudio: {
        id: 'graph',
        spec: { nodes, edges: sequence, algorithm: { kind: 'kruskal' } },
      },
      operandSources: [
        { field: 'geometryStudio.spec.algorithm.kind', quote: 'Kruskal' },
        { field: 'geometryStudio.spec.edges', quote },
      ],
    };
    const scene = planStudioScene(draft);
    if (scene?.type !== 'geometry' || scene.geometryStudio.id !== 'graph')
      throw new Error('Expected a graph scene');
    const proof = checkStudioOperands(scene, draft, [passage], passage, true);
    return { scene, proof };
  };
  const { scene, proof } = verify(edges);
  expect(proof.rejectedField).toBeUndefined();
  expect(scene.geometryStudio.spec.edges.every(edge => edge.weight === undefined)).toBe(true);
  expect(verify([edges[1], edges[0], ...edges.slice(2)]).proof.rejectedField).toBe(
    'geometryStudio.spec.edges'
  );
  expect(verify(edges.filter((_, index) => index !== 2)).proof.rejectedField).toBe(
    'geometryStudio.spec.edges'
  );
  expect(
    verify(edges, `Ecco gli ${order}, ma non vanno usati. Eseguiamo Kruskal.`).proof.rejectedField
  ).toBe('geometryStudio.spec.edges');
  expect(
    verify(edges, `Ecco gli ${order}, dal più caro al più economico. Eseguiamo Kruskal.`).proof
      .rejectedField
  ).toBe('geometryStudio.spec.edges');
  const prose =
    'In ordine crescente di costo, gli archi sono (B, C), (A, B); poi (A, C) e infine (C, D)';
  expect(verify(edges, `${prose}. Eseguiamo Kruskal.`, prose).proof.rejectedField).toBeUndefined();
  const extendedQuote = `gli ${order}.`;
  expect(verify(edges, section, extendedQuote).proof.rejectedField).toBeUndefined();
  const recap = prose.replace(
    'In ordine crescente di costo, gli archi sono',
    'Gli archi in ordine di costo crescente sono:'
  );
  expect(verify(edges, `${section} ${recap}.`, extendedQuote).proof.rejectedField).toBeUndefined();
  const ascending =
    'dal costo minore al maggiore, gli archi sono (B, C), (A, B), seguiti da (A, C), infine (C, D)';
  const descending = 'gli archi in ordine di costo decrescente sono (C, D), (A, C), (A, B), (B, C)';
  expect(
    verify(edges, `Eseguiamo Kruskal. Per confronto, ${descending}; ${ascending}.`, ascending).proof
      .rejectedField
  ).toBeUndefined();
});

test('Kruskal retains the cited weighted input and shows the final cycle', () => {
  const nodes = ['A', 'B', 'C'].map(id => ({ id, label: id }));
  const candidates = [
    { quote: 'Nel grafo non orientato, A ↔ B pesa 1', edge: { from: 'A', to: 'B', weight: 1 } },
    { quote: 'B ↔ C pesa 2', edge: { from: 'B', to: 'C', weight: 2 } },
    { quote: 'A ↔ C pesa 5', edge: { from: 'A', to: 'C', weight: 5 } },
  ];
  const section = `Sul grafo non orientato applichiamo Kruskal. ${candidates.map(({ quote }) => `${quote}.`).join(' ')}`;
  const ground = (selected: typeof candidates) => {
    const draft = {
      type: 'geometry',
      geometryStudio: {
        id: 'graph',
        spec: { nodes, edges: selected.map(({ edge }) => edge), algorithm: { kind: 'kruskal' } },
      },
      operandSources: [
        { field: 'geometryStudio.spec.algorithm.kind', quote: 'Kruskal' },
        ...selected.map(({ quote }, index) => ({
          field: `geometryStudio.spec.edges.${index}`,
          quote,
        })),
      ],
    };
    const scene = planStudioScene(draft);
    if (scene?.type !== 'geometry' || scene.geometryStudio.id !== 'graph')
      throw new Error('Expected a graph scene');
    return {
      spec: scene.geometryStudio.spec,
      proof: checkStudioOperands(scene, draft, [section], section, true),
    };
  };
  const { spec, proof } = ground(candidates);
  expect(proof.rejectedField).toBeUndefined();
  expect(spec.beats.at(-1)?.event).toBe('skip:2');
  expect(computeGraphTrace(spec).at(-1)?.tree).toEqual([0, 1]);
});
