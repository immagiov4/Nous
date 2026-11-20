import { readerStudioViewports, studioViewportScale } from '@shared/lessonStudios/chartDimensions';
import { buildGraph, checkGraphSpec, GraphSpecSchema } from '@shared/lessonStudios/graph';
import { buildHeap } from '@shared/lessonStudios/heapLayout';
import { boxDistance, vectorBounds } from '@shared/lessonStudios/vectorBounds';
import { vectorPath } from '@shared/lessonStudios/vectorPath';
import { descendants, VectorNode } from '@shared/lessonStudios/vectorScene';
import { assert, expect, test } from 'vitest';

function stage(viewport?: VectorNode['viewport']) {
  const root = new VectorNode('root', {}, viewport);
  root.data.durationMs = '7200';
  return root;
}

const matching = (root: VectorNode, name: string) =>
  [...descendants(root)].filter(node => node.hasClass(name));

function graph(count: number, fields: Partial<ReturnType<typeof GraphSpecSchema.parse>>) {
  const nodes = Array.from({ length: count }, (_, index) => {
    const id = String.fromCharCode(65 + index);
    return { id, label: id };
  });
  return GraphSpecSchema.parse({
    title: 'Il grafo',
    nodes,
    edges: nodes
      .slice(1)
      .map(({ id }, index) => ({ from: nodes[index].id, to: id, directed: true })),
    algorithm: { kind: 'bfs', start: 'A' },
    beats: [],
    ...fields,
  });
}

test('Dijkstra presents the same nonzero cost on the edge, the relaxation and the node', () => {
  const root = stage();
  const spec = graph(2, {
    edges: [{ from: 'A', to: 'B', weight: 0.004 }],
    algorithm: { kind: 'dijkstra', start: 'A', target: 'B' },
    beats: [{ event: 'relax:A:B' }],
  });
  const motion = buildGraph(spec, root, [2000]);
  motion.seek(2.1);
  const texts = [...descendants(root)]
    .filter(node => node.tag === 'text')
    .map(node => node.textContent);
  expect(texts).toContain('0,004');
  expect(texts).toContain('Passando da A, B costa 0,004');
  expect(matching(root, 'graph-distance').map(node => node.textContent)).toEqual(['0', '0,004']);
});

test.each([10, 11, 12])('a %i-node layered chain points toward each successor', count => {
  for (const viewport of Object.values(readerStudioViewports)) {
    const root = stage(viewport);
    buildGraph(graph(count, { layout: 'layered' }), root, []);
    const nodes = matching(root, 'graph-node');
    const lines = matching(root, 'graph-line');
    expect(lines).toHaveLength(count - 1);
    lines.forEach((line, index) => {
      const path = vectorPath(line);
      const start = path.getPointAtLength(0).x;
      const end = path.getPointAtLength(path.getTotalLength()).x;
      const [source] = vectorBounds(nodes[index].children[0]);
      const [target] = vectorBounds(nodes[index + 1].children[0]);
      expect(source.right).toBeLessThanOrEqual(start);
      expect(start).toBeLessThan(end);
      expect(end).toBeLessThan(target.left);
      expect(line.attrs['marker-end']).toBeDefined();
    });
  }
});

test('a reachable Dijkstra target with an overflowing distance gets a numeric diagnostic', () => {
  const spec = graph(3, {
    edges: [
      { from: 'A', to: 'B', weight: 1e308 },
      { from: 'B', to: 'C', weight: 1e308 },
    ],
    algorithm: { kind: 'dijkstra', start: 'A', target: 'C' },
  });
  expect(() => checkGraphSpec(spec)).toThrow(/Dijkstra distance overflow.*B.*C/);
  expect(() => buildGraph(spec, stage(), [])).toThrow(/Dijkstra distance overflow.*B.*C/);
});

test('Dijkstra still follows a representable route when another candidate overflows', () => {
  const root = stage();
  const spec = graph(3, {
    edges: [
      { from: 'A', to: 'B', weight: 1e308, directed: true },
      { from: 'B', to: 'C', weight: 1e308, directed: true },
      { from: 'A', to: 'C', weight: 1.2e308, directed: true },
    ],
    algorithm: { kind: 'dijkstra', start: 'A', target: 'C' },
  });
  const motion = buildGraph(spec, root, []);
  motion.seek(7.2, true);
  expect(matching(root, 'graph-result')[0].textContent).toBe('Percorso più breve: A, C');
  expect(matching(root, 'graph-distance')[2].textContent).toBe('1,2E308');
});

test.each(
  Object.entries(readerStudioViewports)
)('%s heap swap keeps the traveling labels clear of the center bar', (_name, viewport) => {
  const root = stage(viewport);
  const motion = buildHeap({ input: [1, 0.5, 3], beats: [] }, root, []);
  const scale = studioViewportScale(viewport);
  const tiles = matching(root, 'heap-tile');
  let closest = Infinity;
  for (let ms = 0; ms <= 7200; ms += 10) {
    motion.seek(ms / 1000);
    for (const tile of [tiles[0], tiles[2]]) {
      const label = tile.children[1];
      expect((label.label?.size ?? 0) * scale).toBeGreaterThanOrEqual(14);
      const [text] = vectorBounds(label);
      const [bar] = vectorBounds(tiles[1].children[0]);
      assert(text && bar);
      closest = Math.min(closest, boxDistance(text, bar) * scale);
    }
  }
  expect(closest).toBeGreaterThanOrEqual(8);
});
