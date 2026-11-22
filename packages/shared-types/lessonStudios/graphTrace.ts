export type Link = { from: string; to: string; weight?: number; directed?: boolean };
type Arc = { to: string; edge: number; weight: number };
type Distances = Record<string, number>;
type DistanceOverflow = { from: string; to: string; weight: number };
type TraversedEdge = { index: number; from: string };
type Step = {
  event: string;
  focus: string[];
  frontier: string[];
  settled: string[];
  distances?: Distances;
  edge?: TraversedEdge;
  path?: number[];
};

function adjacency(nodes: string[], edges: Link[]) {
  const outgoing = new Map(nodes.map(id => [id, [] as Arc[]]));
  edges.forEach(({ from, to, weight = 1, directed }, edge) => {
    outgoing.get(from)!.push({ to, weight, edge });
    if (!directed) outgoing.get(to)!.push({ to: from, weight, edge });
  });
  return outgoing;
}

function checkDistanceOverflow(distances: Distances, overflows: DistanceOverflow[]) {
  // An overflowing candidate is harmless when some other route reaches the same node.
  const overflow = overflows.find(({ to }) => !Number.isFinite(distances[to]));
  if (!overflow) return;
  const { from, to, weight } = overflow;
  throw new RangeError(`Dijkstra distance overflow from ${from} to ${to}`, {
    cause: { distance: distances[from], weight },
  });
}

export function shortestPaths(nodes: string[], edges: Link[], start: string, target: string) {
  const outgoing = adjacency(nodes, edges);
  const distances: Distances = Object.fromEntries(
    nodes.map(id => [id, id === start ? 0 : Infinity])
  );
  const settled = new Set<string>();
  const predecessors = new Map<string, { from: string; edge: number }>();
  const overflows: DistanceOverflow[] = [];
  const steps: Step[] = [];
  function emit(event: string, focus: string[], edge?: TraversedEdge, path?: number[]) {
    steps.push({
      event,
      focus,
      edge,
      path,
      distances: { ...distances },
      settled: [...settled],
      frontier: nodes.filter(id => !settled.has(id) && Number.isFinite(distances[id])),
    });
  }
  emit('start', [start]);
  while (true) {
    const current = nodes
      .filter(id => !settled.has(id) && Number.isFinite(distances[id]))
      .sort((a, b) => distances[a] - distances[b])[0];
    if (current === undefined) break;
    settled.add(current);
    emit('visit:' + current, [current]);
    for (const { to, weight, edge } of outgoing.get(current)!) {
      if (settled.has(to)) continue;
      const candidate = distances[current] + weight;
      if (!Number.isFinite(candidate)) {
        overflows.push({ from: current, to, weight });
        continue;
      }
      if (candidate >= distances[to]) continue;
      distances[to] = candidate;
      predecessors.set(to, { from: current, edge });
      emit('relax:' + current + ':' + to, [current, to], { index: edge, from: current });
    }
  }
  checkDistanceOverflow(distances, overflows);
  const path: number[] = [];
  const focus = [target];
  for (let id = target; predecessors.has(id); ) {
    const { from, edge } = predecessors.get(id)!;
    path.unshift(edge);
    focus.unshift(from);
    id = from;
  }
  emit('done', focus, undefined, path);
  return steps;
}

export function traverse(nodes: string[], edges: Link[], mode: 'bfs' | 'dfs', start: string) {
  const outgoing = adjacency(nodes, edges);
  const pending: { id: string; edge?: TraversedEdge }[] = [{ id: start }];
  const visited = new Set<string>();
  const known = new Set([start]);
  const steps: Step[] = [{ event: 'start', focus: [start], frontier: [start], settled: [] }];
  while (pending.length) {
    const { id, edge } = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const next = outgoing
      .get(id)!
      .filter(arc => !visited.has(arc.to) && (mode === 'dfs' || !known.has(arc.to)))
      .map(arc => ({ id: arc.to, edge: { index: arc.edge, from: id } }));
    next.forEach(entry => known.add(entry.id));
    if (mode === 'dfs') {
      const nextIds = new Set(next.map(entry => entry.id));
      const remaining = pending.filter(entry => !nextIds.has(entry.id));
      pending.splice(0, pending.length, ...next, ...remaining);
    } else pending.push(...next);
    steps.push({
      event: 'visit:' + id,
      focus: [id],
      frontier: pending.map(entry => entry.id),
      settled: [...visited],
      edge,
    });
  }
  steps.push({ event: 'done', focus: [...visited], frontier: [], settled: [...visited] });
  return steps;
}

export function topological(nodes: string[], edges: Link[]) {
  const outgoing = adjacency(nodes, edges);
  const degrees = new Map(nodes.map(id => [id, 0]));
  edges.forEach(({ to }) => degrees.set(to, degrees.get(to)! + 1));
  const ready = nodes.filter(id => degrees.get(id) === 0);
  const settled: string[] = [];
  const steps: Step[] = [{ event: 'start', focus: [...ready], frontier: [...ready], settled: [] }];
  while (ready.length) {
    const id = ready.shift()!;
    settled.push(id);
    for (const { to } of outgoing.get(id)!) {
      const remaining = degrees.get(to)! - 1;
      degrees.set(to, remaining);
      if (!remaining) ready.push(to);
    }
    steps.push({ event: 'visit:' + id, focus: [id], frontier: [...ready], settled: [...settled] });
  }
  if (settled.length !== nodes.length)
    throw new Error('Topological order requires a directed acyclic graph');
  steps.push({ event: 'done', focus: [...settled], frontier: [], settled: [...settled] });
  return steps;
}

export function graphDescendants(edges: Link[], root: string) {
  const seen = new Set([root]);
  const pending = [root];
  while (pending.length) {
    const parent = pending.shift()!;
    for (const { from, to } of edges) {
      if (from !== parent || seen.has(to)) continue;
      seen.add(to);
      pending.push(to);
    }
  }
  seen.delete(root);
  return seen;
}
