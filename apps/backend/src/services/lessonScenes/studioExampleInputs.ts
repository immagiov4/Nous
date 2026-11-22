import { arrayBeatCopy } from '@shared/lessonStudios/array-algorithm.copy.it';
import type { ArraySpec } from '@shared/lessonStudios/arrayAlgorithm';
import { formatOperand } from '@shared/lessonStudios/chart';
import { graphBeatCopy } from '@shared/lessonStudios/graph.copy.it';
import type { GraphSpec } from '@shared/lessonStudios/graphSpec';
import { perspectiveBeatCopy } from '@shared/lessonStudios/plane.copy.it';
import type { Layer, Spec as PlaneSpec } from '@shared/lessonStudios/planeSpec';

// One exchange demonstrates sorting without a long series of repeated passes.
const sortInput = [2, 1, 3, 4];
const searchInput = [1, 3, 5, 7, 9];
const searchTarget = 7;

export function arrayExample(algorithm: ArraySpec['algorithm']) {
  const input = algorithm === 'binary-search' ? searchInput : sortInput;
  const target = algorithm === 'binary-search' ? searchTarget : undefined;
  const values = input.map(formatOperand).join(', ');
  return {
    spec: { algorithm, input, target, callouts: [] } satisfies ArraySpec,
    introduction:
      target === undefined
        ? arrayBeatCopy.example(values)
        : arrayBeatCopy.exampleSearch(values, formatOperand(target)),
  };
}

export function graphExample(algorithm: 'dijkstra' | 'prim' | 'kruskal' | 'topo-sort'): {
  spec: Omit<GraphSpec, 'title' | 'beats'>;
  introduction: string;
} {
  const nodes = ['A', 'B', 'C', 'D'].map(id => ({ id, label: id }));
  if (algorithm === 'topo-sort') {
    const edges = [
      { from: 'A', to: 'B', directed: true },
      { from: 'A', to: 'C', directed: true },
      { from: 'B', to: 'D', directed: true },
      { from: 'C', to: 'D', directed: true },
    ];
    return {
      spec: {
        nodes,
        edges,
        algorithm: { kind: algorithm },
        topologicalReadout: 'dependency-order',
      },
      introduction: graphBeatCopy.topologyExample,
    };
  }
  const edges = [
    { from: 'A', to: 'B', weight: 2 },
    { from: 'A', to: 'C', weight: 5 },
    { from: 'B', to: 'C', weight: 1 },
    { from: 'C', to: 'D', weight: algorithm === 'kruskal' ? 6 : 2 },
  ];
  const start = 'A';
  const target = 'D';
  const weights = edges
    .map(({ from, to, weight }) => `${from}–${to} (${formatOperand(weight)})`)
    .join(', ');
  const treeIntroduction =
    algorithm === 'kruskal' ? graphBeatCopy.kruskalExample : graphBeatCopy.treeExample(weights);
  return {
    spec: {
      nodes,
      edges,
      algorithm: {
        kind: algorithm,
        ...(algorithm !== 'kruskal' && { start }),
        ...(algorithm === 'dijkstra' && { target }),
      },
    },
    introduction:
      algorithm === 'dijkstra' ? graphBeatCopy.example(start, target, weights) : treeIntroduction,
  };
}

export function perspectiveExample() {
  const floor = {
    type: 'floor',
    vanishing: [0, 2],
    near: [
      [-4, -3],
      [4, -3],
    ],
    tiles: 4,
    rows: 4,
  } satisfies Omit<Extract<Layer, { type: 'floor' }>, 'id'>;
  const spec = {
    title: perspectiveBeatCopy.title,
    x: [-5, 5],
    y: [-4, 3],
    grid: false,
    layers: [
      { ...floor, id: 'rays', part: 'rays' },
      { ...floor, id: 'tiles', part: 'tiles' },
    ],
    beats: [
      { focus: ['rays'], show: ['rays'] },
      { focus: ['tiles'], show: ['rays', 'tiles'] },
    ],
  } satisfies PlaneSpec;
  return {
    spec,
    beats: [
      { sentence: perspectiveBeatCopy.rays, targets: spec.beats[0].focus },
      { sentence: perspectiveBeatCopy.tiles, targets: spec.beats[1].focus },
    ],
  };
}
