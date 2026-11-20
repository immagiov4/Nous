import dagre from '@dagrejs/dagre';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
} from 'd3';
import type { Link } from './graphTrace';
import type { Point } from './vectorScene';

function spread(values: number[], low: number, high: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return values.map(value =>
    max === min ? (low + high) / 2 : low + ((value - min) / (max - min)) * (high - low)
  );
}

export function graphLayout(
  ids: string[],
  edges: Link[],
  layout: 'tree' | 'layered' | 'force' | 'ring',
  hud: boolean
) {
  if (layout === 'ring') {
    return new Map(
      ids.map((id, i) => {
        const angle = Math.PI * ((2 * i) / ids.length - 0.5);
        return [id, [500 + 362 * Math.cos(angle), 215 + 150 * Math.sin(angle)] as Point];
      })
    );
  }

  let points: Point[];
  if (layout === 'force') {
    let seed = 86;
    const nodes: { id: string; x?: number; y?: number }[] = ids.map(id => ({ id }));
    forceSimulation(nodes)
      .stop()
      .randomSource(() => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
      })
      .force(
        'links',
        forceLink<(typeof nodes)[number], SimulationLinkDatum<(typeof nodes)[number]>>(
          edges.map(({ from, to }) => ({ source: from, target: to }))
        )
          .id(node => node.id)
          .distance(172)
      )
      .force('charge', forceManyBody().strength(-390))
      .force('collision', forceCollide(76))
      .tick(300);
    points = nodes.map(node => [node.x!, node.y!]);
  } else {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: layout === 'tree' ? 'TB' : 'LR', ranksep: 60, nodesep: 42 });
    graph.setDefaultEdgeLabel(() => ({}));
    ids.forEach(id => graph.setNode(id, { width: 138, height: 56 }));
    edges.forEach(({ from, to }) => graph.setEdge(from, to));
    dagre.layout(graph);
    points = ids.map(id => [graph.node(id).x, graph.node(id).y]);
  }

  const x = spread(
    points.map(point => point[0]),
    hud ? 103 : 135,
    hud ? 897 : 865
  );
  const tree = layout === 'tree';
  const top = tree ? 45 : 89;
  const bottom = tree ? 415 : 385;
  const y = spread(
    points.map(point => point[1]),
    hud ? 57 : top,
    hud ? 355 : bottom
  );
  return new Map(ids.map((id, i) => [id, [x[i], y[i]] as Point]));
}
