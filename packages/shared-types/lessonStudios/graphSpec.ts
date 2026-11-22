import * as z from 'zod';
import { geometryBeatFields as beatFields, studioEntityId as entityId } from './geometryStudioSpec';
import {
  graphDescendants,
  minimumSpanningTree,
  shortestPaths,
  topological,
  traverse,
} from './graphTrace';

const id = entityId;
const nonBlank = z.string().min(1).regex(/\S/u);
export const MAX_GRAPH_NODES = 12;
export const MAX_GRAPH_EDGES = 28;
const algorithm = z.object({
  kind: z.enum(['dijkstra', 'bfs', 'dfs', 'topo-sort']),
  start: id.optional(),
  target: id.optional(),
});
const beat = z.object({
  ...beatFields,
  event: z.string().meta({ graphEvent: true }),
  nodes: z.array(id).min(1).optional(),
  winner: id.optional(),
  reason: nonBlank.optional(),
  pair: z.tuple([nonBlank, nonBlank]).optional(),
  prevails: z.union([z.literal(0), z.literal(1)]).optional(),
});
export const PrePrimGraphSpecSchema = z.object({
  title: nonBlank,
  layout: z.enum(['layered', 'tree', 'force', 'ring']).optional(),
  relation: z.enum(['rank', 'containment']).optional(),
  nodes: z
    .array(z.object({ id, label: nonBlank, group: nonBlank.optional() }))
    .min(1)
    .max(MAX_GRAPH_NODES),
  edges: z
    .array(
      z.object({
        from: id,
        to: id,
        weight: z.number().optional(),
        label: nonBlank.optional(),
        directed: z.boolean().optional(),
      })
    )
    .max(MAX_GRAPH_EDGES),
  algorithm: algorithm.optional(),
  beats: z.array(beat).max(32),
});
export const GraphSpecSchema = PrePrimGraphSpecSchema.extend({
  algorithm: algorithm
    .extend({
      kind: z.enum([...algorithm.shape.kind.options, 'prim']),
      stopAtTarget: z.literal(true).optional(),
    })
    .optional(),
});
export type GraphSpec = z.infer<typeof GraphSpecSchema>;

export function computeGraphTrace(spec: GraphSpec) {
  const nodes = spec.nodes.map(node => node.id);
  const { edges, algorithm } = spec;
  if (!algorithm) return [];
  const { kind, start, target, stopAtTarget } = algorithm;
  if (kind === 'topo-sort') {
    if (edges.some(edge => !edge.directed))
      throw new Error('Topological sort requires directed edges');
    return topological(nodes, edges);
  }
  if (kind === 'prim') {
    const origin = start ?? nodes[0];
    if (!nodes.includes(origin) || target !== undefined)
      throw new Error('Prim accepts a start node and spans the entire graph');
    return minimumSpanningTree(nodes, edges, origin);
  }
  if (!start || !nodes.includes(start)) throw new Error('Provide a valid start node');
  if (kind !== 'dijkstra') {
    if (stopAtTarget && (!target || !nodes.includes(target)))
      throw new Error('A bounded traversal requires a valid target node');
    return traverse(nodes, edges, kind, start, stopAtTarget ? target : undefined);
  }
  if (
    !target ||
    !nodes.includes(target) ||
    edges.some(edge => edge.weight !== undefined && edge.weight < 0)
  ) {
    throw new Error('Dijkstra requires a valid target and nonnegative weights');
  }
  return shortestPaths(nodes, edges, start, target);
}

export function graphHierarchy(spec: GraphSpec) {
  if (spec.algorithm || !spec.edges.length) return null;
  const incoming = new Set(spec.edges.map(edge => edge.to));
  const root = spec.nodes.find(node => !incoming.has(node.id));
  const rootedTree =
    root &&
    incoming.size === spec.nodes.length - 1 &&
    spec.edges.length === incoming.size &&
    graphDescendants(spec.edges, root.id).size === spec.nodes.length - 1;
  if (!rootedTree) return null;
  const legacyHierarchy =
    (spec.layout ?? 'layered') === 'layered' &&
    spec.edges.every(edge => edge.directed && edge.weight === undefined);
  if (spec.layout !== 'tree' && !spec.relation && !legacyHierarchy) return null;
  const chain = spec.nodes.every(
    node => spec.edges.filter(edge => edge.from === node.id).length < 2
  );
  return chain && spec.relation !== 'containment' ? 'pyramid' : 'tree';
}

export function checkGraphSpec(spec: GraphSpec) {
  const ids = new Set(spec.nodes.map(node => node.id));
  if (ids.size !== spec.nodes.length) throw new Error('Node ids must be unique');
  const links = checkGraphLinks(spec.edges, ids);
  const rank = graphHierarchy(spec);
  if ((spec.layout === 'tree' || spec.relation) && !rank)
    throw new Error('Hierarchy needs one rooted tree');
  if (spec.algorithm) {
    checkAlgorithmCues(spec);
    return;
  }
  for (const cue of spec.beats) checkRelationCue(cue, ids, links, rank);
}

function checkGraphLinks(edges: GraphSpec['edges'], ids: Set<string>) {
  const links = new Set<string>();
  for (const edge of edges) {
    const { from, to, directed } = edge;
    if (
      from === to ||
      !ids.has(from) ||
      !ids.has(to) ||
      links.has(from + ':' + to) ||
      (!directed && links.has(to + ':' + from))
    )
      throw new Error('Invalid or duplicate edge');
    links.add(from + ':' + to);
    if (!directed) links.add(to + ':' + from);
  }
  return links;
}

function checkAlgorithmCues(spec: GraphSpec) {
  const trace = computeGraphTrace(spec);
  let last = -1;
  for (const cue of spec.beats) {
    const index = trace.findIndex(step => step.event === cue.event);
    if (index <= last)
      throw new Error('Graph cue must name a computed event in order: ' + cue.event);
    last = index;
  }
}

function checkRelationCue(
  cue: GraphSpec['beats'][number],
  ids: Set<string>,
  links: Set<string>,
  rank: ReturnType<typeof graphHierarchy>
) {
  const { event, nodes = [], winner, reason, pair, prevails } = cue;
  if (!nodes.every(node => ids.has(node))) throw new Error('Invalid beat nodes');
  if (
    event === 'compare' &&
    pair &&
    prevails !== undefined &&
    nodes.length === 2 &&
    reason &&
    !winner
  )
    return;
  if (new Set(nodes).size !== nodes.length || pair || prevails !== undefined)
    throw new Error('Invalid beat nodes');
  if (event === 'reveal') return;
  if (event === 'collapse-subtree' && rank && nodes.length === 1) return;
  if (event === 'compare' && nodes.length === 2 && winner && nodes.includes(winner) && reason)
    return;
  if (
    event === 'highlight-path' &&
    nodes.length >= 2 &&
    nodes.slice(1).every((node, i) => links.has(nodes[i] + ':' + node))
  )
    return;
  throw new Error('Invalid graph beat: ' + event);
}
