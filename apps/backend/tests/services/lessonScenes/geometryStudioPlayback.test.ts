import {
  buildFunctionPlot,
  checkFunctionPlotSpec,
  FunctionPlotSpecSchema,
} from '@shared/lessonStudios/functionPlot';
import { findGeometryProblems } from '@shared/lessonStudios/geometry';
import { buildGraph, checkGraphSpec, GraphSpecSchema } from '@shared/lessonStudios/graph';
import { buildPlane } from '@shared/lessonStudios/plane';
import { compile, roots, sample } from '@shared/lessonStudios/planeMath';
import { checkPlaneSpec, PlaneSpecSchema } from '@shared/lessonStudios/planeSpec';
import {
  buildTrajectories,
  checkTrajectoriesSpec,
  TrajectoriesSpecSchema,
} from '@shared/lessonStudios/trajectories';
import { isVisible } from '@shared/lessonStudios/vectorBounds';
import { descendants, VectorNode } from '@shared/lessonStudios/vectorScene';
import { assert, expect, test } from 'vitest';

function stage(durationMs: number) {
  const root = new VectorNode('root');
  root.data.durationMs = String(durationMs);
  return root;
}

const nodes = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, label: id }));
const weightedEdges = [
  { from: 'A', to: 'B', weight: 7 },
  { from: 'A', to: 'C', weight: 2 },
  { from: 'C', to: 'B', weight: 1 },
  { from: 'C', to: 'D', weight: 7 },
  { from: 'B', to: 'D', weight: 2 },
  { from: 'D', to: 'E', weight: 1 },
];

function graphResult(root: VectorNode) {
  return [...descendants(root)].find(node => node.hasClass('graph-result'))?.textContent;
}

test('Dijkstra draws a cheaper route through C and resets the distances on backward seek', () => {
  const root = stage(18_000);
  const spec = GraphSpecSchema.parse({
    title: 'Il cammino minimo di Dijkstra',
    layout: 'layered',
    nodes,
    edges: weightedEdges,
    algorithm: { kind: 'dijkstra', start: 'A', target: 'E' },
    beats: [
      { event: 'start' },
      { event: 'visit:A' },
      { event: 'visit:C' },
      { event: 'relax:C:B' },
      { event: 'relax:B:D' },
      { event: 'done' },
    ],
  });
  checkGraphSpec(spec);
  const motion = buildGraph(spec, root, [0, 3000, 6000, 9000, 12_000, 15_000]);
  const distances = () =>
    [...descendants(root)]
      .filter(node => node.hasClass('graph-distance'))
      .map(node => node.textContent);
  motion.seek(0);
  expect(distances()).toEqual(['0', '∞', '∞', '∞', '∞']);
  motion.seek(9.6);
  expect(distances()[1]).toBe('3');
  motion.seek(18);
  expect(distances()).toEqual(['0', '3', '2', '5', '6']);
  expect(graphResult(root)).toBe('Percorso più breve: A, C, B, D, E');
  motion.seek(0, true);
  expect(distances()).toEqual(['0', '∞', '∞', '∞', '∞']);
});

test('a graph cue at zero starts the prerequisite moves and still visits the selected node', () => {
  const root = stage(4500);
  const spec = GraphSpecSchema.parse({
    title: 'Visita in ampiezza',
    nodes: nodes.slice(0, 3),
    edges: [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ],
    algorithm: { kind: 'bfs', start: 'A' },
    beats: [{ event: 'visit:C' }, { event: 'done' }],
  });
  const motion = buildGraph(spec, root, [0, 3000]);
  const active = (seconds: number) => {
    motion.seek(seconds);
    return [...descendants(root)]
      .filter(node => node.attrs['data-state'] === 'active')
      .map(node => node.attrs['data-node']);
  };
  const visited = Array.from({ length: 30 }, (_, index) => active(index / 50)).flat();
  expect([...new Set(visited)]).toEqual(['A', 'B', 'C']);
});

test('a short first cue interval still visits every node before the next pin', () => {
  const root = stage(1000);
  const spec = GraphSpecSchema.parse({
    title: 'Visita in ampiezza',
    nodes: nodes.slice(0, 4),
    edges: [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'C', to: 'D' },
    ],
    algorithm: { kind: 'bfs', start: 'A' },
    beats: [{ event: 'visit:B' }, { event: 'done' }],
  });
  const motion = buildGraph(spec, root, [0, 250]);
  const visited = new Set<string | number>();
  for (let ms = 0; ms < 250; ms += 5) {
    motion.seek(ms / 1000);
    for (const node of descendants(root)) {
      if (node.attrs['data-state'] === 'active') visited.add(node.attrs['data-node']);
    }
  }
  expect([...visited]).toEqual(['A', 'B', 'C', 'D']);
});

test('a tiny but genuine crossing still places its intersection', () => {
  expect(roots(x => 1e-200 * (x - 0.37), [0, 0.5, 1])[0]).toBeCloseTo(0.37, 8);
});

test('a stored graph rejects two distinct anchors in the same narrated word', () => {
  const scene = {
    autoplay: true,
    narration: 'AlphaBetaGamma moves.',
    geometryStudio: {
      id: 'graph',
      spec: {
        title: 'Visita',
        nodes: [{ id: 'a', label: 'A' }],
        edges: [],
        algorithm: { kind: 'bfs', start: 'a' },
        beats: [{ event: 'visit:a' }, { event: 'done' }],
      },
    },
    studioCues: [{ anchor: 'Beta' }, { anchor: 'Gamma' }],
  };
  expect(findGeometryProblems(scene)).toEqual([
    'Each geometry beat must start at a distinct narration time.',
  ]);
  expect(
    findGeometryProblems({ ...scene, studioCues: [{ anchor: 'Alpha' }, { anchor: 'moves' }] })
  ).toEqual([]);
});

test.each([
  ['bfs', 'A, B, C, D, E'],
  ['dfs', 'A, B, D, E, C'],
  ['topo-sort', 'A, B, C, D, E'],
])('%s draws the computed visit order', (kind, order) => {
  const root = stage(10_000);
  const spec = GraphSpecSchema.parse({
    title: 'Visita del grafo',
    layout: 'ring',
    nodes,
    edges: [
      { from: 'A', to: 'B', directed: true },
      { from: 'A', to: 'C', directed: true },
      { from: 'B', to: 'D', directed: true },
      { from: 'D', to: 'E', directed: true },
    ],
    algorithm: { kind, start: 'A' },
    beats: [{ event: 'start' }, { event: 'done' }],
  });
  checkGraphSpec(spec);
  buildGraph(spec, root, [0, 8000]).seek(9, true);
  expect(graphResult(root)).toBe(`Ordine   ${order}`);
});

test('a rule comparison links both examples to their legal levels', () => {
  const root = stage(6000);
  const spec = GraphSpecSchema.parse({
    title: 'Gerarchia delle fonti',
    layout: 'tree',
    relation: 'rank',
    nodes: [
      { id: 'cost', label: 'Costituzione' },
      { id: 'leggi', label: 'Leggi' },
      { id: 'reg', label: 'Regolamenti' },
    ],
    edges: [
      { from: 'cost', to: 'leggi' },
      { from: 'leggi', to: 'reg' },
    ],
    beats: [
      { event: 'reveal' },
      {
        event: 'compare',
        nodes: ['leggi', 'reg'],
        pair: ['Legge ordinaria', 'Regolamento'],
        reason: 'La legge è una fonte di grado superiore',
        prevails: 0,
      },
    ],
  });
  checkGraphSpec(spec);
  buildGraph(spec, root, [0, 3000]).seek(4, true);
  const visible = [...descendants(root)].filter(isVisible);
  expect(visible.filter(node => node.hasClass('graph-norm-link'))).toHaveLength(2);
  const winner = visible
    .filter(node => node.hasClass('graph-node') && node.attrs['data-state'] === 'settled')
    .flatMap(node => node.children.map(child => child.textContent));
  expect(winner).toContain('Legge ordinaria');
});

test('changing a matrix doubles the unit square and can collapse it onto a line', () => {
  const root = stage(9000);
  const spec = PlaneSpecSchema.parse({
    title: 'Una matrice trasforma il piano',
    x: [-3.7, 6],
    y: [-1.6, 2.42],
    grid: false,
    parameters: { a: 1, b: 0, d: 1 },
    layers: [
      {
        id: 'grid',
        type: 'grid-transform',
        matrix: [
          ['a', 'b'],
          [0, 'd'],
        ],
      },
    ],
    beats: [
      { focus: ['grid'] },
      { focus: ['grid'], set: { a: 2, b: 1 } },
      { focus: ['grid'], set: { d: 0 } },
    ],
  });
  checkPlaneSpec(spec);
  const motion = buildPlane(spec, root, [0, 3000, 6000]);
  const square = () =>
    [...descendants(root)].find(
      node =>
        String(node.attrs.d).startsWith('M') &&
        node.attrs.fill &&
        String(node.attrs.fill).startsWith('color-mix')
    )?.attrs.d;
  const area = () =>
    [...descendants(root)]
      .filter(node => node.hasClass('plane-label') && isVisible(node))
      .find(node => node.textContent.startsWith('Area '))?.textContent;
  motion.seek(1);
  const initial = square();
  expect(initial).toMatch(/^M.+Z$/u);
  expect(area()).toBe('Area 1');
  motion.seek(4);
  expect(square()).not.toBe(initial);
  expect(area()).toBe('Area 2');
  motion.seek(8);
  expect(area()).toBe('Area 0');
  motion.seek(1);
  expect(square()).toBe(initial);
});

test('crossing the critical angle removes the transmitted ray', () => {
  const root = stage(7000);
  const spec = PlaneSpecSchema.parse({
    title: 'La rifrazione della luce',
    x: [-5, 5],
    y: [-2, 2],
    grid: false,
    parameters: { n1: 1.33, n2: 1, angle: 45 },
    layers: [
      {
        id: 'ray',
        type: 'snell',
        n1: 'n1',
        n2: 'n2',
        angle: 'angle',
        media: [
          { index: 1, name: 'Aria' },
          { index: 1.33, name: 'Acqua' },
        ],
      },
    ],
    beats: [{ focus: ['ray'] }, { focus: ['ray'], set: { angle: 55 } }],
  });
  checkPlaneSpec(spec);
  const motion = buildPlane(spec, root, [0, 3000]);
  const drawing = () => [...descendants(root)].find(node => node.attrs['data-layer'] === 'ray');
  motion.seek(1);
  const refraction = drawing()?.children.length;
  expect(refraction).toBeGreaterThan(0);
  motion.seek(5);
  expect(drawing()?.children.length).toBeLessThan(refraction ?? 0);
  expect(drawing()?.children.some(node => node.attrs['data-optics-status'] !== undefined)).toBe(
    true
  );
  motion.seek(1);
  expect(drawing()?.children.length).toBe(refraction);
});

test('computed roots include crossings and tangencies while excluding a vertical pole', () => {
  const domain = sample([-2, 3]);
  const expression = compile(' (x − a) ^ 2 × (x + 1) ', ['a']);
  expect(roots(x => expression(x, { a: 0.35 }), domain)).toEqual([
    expect.closeTo(-1, 6),
    expect.closeTo(0.35, 6),
  ]);
  const pole = compile('1 ÷ (x - a)', ['a']);
  expect(roots(x => pole(x, { a: 0.35 }), domain)).toEqual([]);
  const sine = compile('sin(-x) + sqrt(4) - 2', []);
  expect(sine(Math.PI / 2, {})).toBeCloseTo(-1);
  expect(() => compile('x^(', [])).toThrow('Invalid curve operand');
  expect(() => compile('x$2', [])).toThrow('Invalid curve expression');
});

test('a perspective grid draws its converging rays before the floor tiles', () => {
  const root = stage(12_000);
  const spec = PlaneSpecSchema.parse({
    title: 'La prospettiva centrale',
    x: [-7.2, 7.2],
    y: [-3.05, 3.05],
    grid: false,
    layers: [
      { id: 'vp', type: 'point', at: [0, 1.85], name: 'Punto di fuga' },
      {
        id: 'h',
        type: 'construction',
        through: [
          [-6.4, 1.4],
          [6.4, 1.85],
        ],
        horizon: 1.85,
      },
      {
        id: 'rays',
        type: 'floor',
        vanishing: 'vp',
        near: [
          [-6, -2.6],
          [6, -2.6],
        ],
        rows: 9,
        tiles: 6,
        part: 'rays',
      },
      {
        id: 'tiles',
        type: 'floor',
        vanishing: 'vp',
        near: [
          [-6, -2.6],
          [6, -2.6],
        ],
        rows: 9,
        tiles: 6,
      },
    ],
    beats: [
      { focus: ['vp', 'h'], show: ['vp', 'h'] },
      { focus: ['rays'], show: ['vp', 'h', 'rays'] },
      { focus: ['tiles'], show: ['vp', 'h', 'rays', 'tiles'] },
    ],
  });
  checkPlaneSpec(spec);
  const motion = buildPlane(spec, root, [0, 2500, 7500]);
  const visibleLayer = (id: string) =>
    [...descendants(root)].find(node => node.attrs['data-layer'] === id && isVisible(node));
  motion.seek(1);
  expect(visibleLayer('rays')).toBeUndefined();
  motion.seek(7);
  expect(visibleLayer('rays')?.children).toHaveLength(7);
  expect(visibleLayer('tiles')).toBeUndefined();
  motion.seek(11.9);
  const tiles = visibleLayer('tiles')?.children.filter(node => String(node.attrs.d).endsWith('Z'));
  expect(tiles).toHaveLength(27);
  motion.seek(1);
  expect(visibleLayer('tiles')).toBeUndefined();
});

test('function plot features follow the roots as the curve loses its intersections', () => {
  const root = stage(5000);
  const spec = FunctionPlotSpecSchema.parse({
    family: 'quadratic',
    xRange: [-3, 3],
    yRange: [-4, 6],
    features: ['roots', 'vertex', 'intercepts'],
    keyframes: [
      { params: { a: 1, b: 0, c: -1 }, label: 'La curva taglia l’asse' },
      { params: { a: 1, b: 0, c: 1 }, label: 'La curva resta sopra' },
    ],
  });
  checkFunctionPlotSpec(spec);
  const motion = buildFunctionPlot(spec, root, [0, 2500]);
  const visibleDots = () =>
    [...descendants(root)].filter(node => node.hasClass('feature') && isVisible(node));
  motion.seek(1);
  expect(visibleDots()).toHaveLength(3);
  motion.seek(4);
  expect(visibleDots()).toHaveLength(1);
  motion.seek(1, true);
  expect(visibleDots()).toHaveLength(3);
});

test('the plane draws real intersection points, an enclosed region and the limit of the secant', () => {
  const root = stage(10_000);
  const spec = PlaneSpecSchema.parse({
    title: 'La parabola incontra la retta',
    x: [-2, 2],
    y: [-1, 4],
    grid: false,
    parameters: { h: 0.5 },
    layers: [
      { id: 'curve', type: 'curve', expr: 'x^2' },
      { id: 'height', type: 'line', form: { m: 0, b: 1 } },
      { id: 'crossings', type: 'intersection', of: ['curve', 'height'], name: 'Incontro' },
      { id: 'region', type: 'region', between: ['curve', 'height'], where: 'below' },
      { id: 'tangent', type: 'tangent', of: 'curve', x: 1, h: 'h' },
    ],
    beats: [
      { focus: ['crossings'], show: ['curve', 'height', 'crossings'] },
      { focus: ['region'], show: ['curve', 'height', 'region'] },
      { focus: ['tangent'], show: ['curve', 'tangent'] },
      { focus: ['tangent'], set: { h: 0 } },
    ],
  });
  checkPlaneSpec(spec);
  const motion = buildPlane(spec, root, [0, 2500, 5000, 7500]);
  const layers = (id: string) =>
    [...descendants(root)].filter(
      node => node.parent?.attrs['data-layer'] === id && isVisible(node)
    );
  motion.seek(1);
  const crossings = layers('crossings').filter(node => node.tag === 'circle');
  expect(crossings).toHaveLength(2);
  expect(crossings[0].number('cy')).toBeCloseTo(crossings[1].number('cy'));
  expect(crossings[0].number('cx')).toBeLessThan(crossings[1].number('cx'));
  motion.seek(4);
  expect(layers('region').filter(node => String(node.attrs.d).endsWith('Z'))).toHaveLength(1);
  motion.seek(6);
  expect(layers('tangent').some(node => node.attrs['stroke-dasharray'] === '5 5')).toBe(true);
  motion.seek(9);
  expect(layers('tangent').some(node => node.attrs['stroke-dasharray'] === '5 5')).toBe(false);
  expect(layers('tangent').some(node => node.textContent === 'pendenza = 2')).toBe(true);
});

test('the circle traces one period of the sine wave while keeping both projections in scale', () => {
  const root = stage(8000);
  const spec = PlaneSpecSchema.parse({
    title: 'Dal cerchio alla sinusoide',
    x: [-1.3, 8],
    y: [-1.25, 1.25],
    grid: false,
    parameters: { theta: 45 },
    layers: [
      {
        id: 'wave',
        type: 'unit-circle-wave',
        angle: 'theta',
        waveStart: 1.5,
        sineName: 'Seno',
        cosineName: 'Coseno',
      },
    ],
    beats: [{ focus: ['wave'] }, { focus: ['wave'], wave: true, set: { theta: 360 } }],
  });
  checkPlaneSpec(spec);
  const motion = buildPlane(spec, root, [0, 3000]);
  const trace = () =>
    [...descendants(root)].find(
      node => node.tag === 'path' && [...String(node.attrs.d).matchAll(/L/gu)].length === 96
    );
  motion.seek(1);
  expect(trace()).toBeUndefined();
  motion.seek(8);
  const wave = trace();
  assert(wave);
  const points = [...String(wave.attrs.d).matchAll(/[ML]([^ML]+)/gu)].map(([, point]) =>
    point.trim().split(/\s+/u).map(Number)
  );
  expect(points).toHaveLength(97);
  expect(points[0][0]).toBeLessThan(points.at(-1)?.[0] ?? 0);
  expect(points[24][1]).toBeLessThan(points[0][1]);
  expect(points[72][1]).toBeGreaterThan(points[0][1]);
});

test('the trajectory drawing reveals the gap only when the narration compares the paths', () => {
  const root = stage(16_000);
  const spec = TrajectoriesSpecSchema.parse({
    title: 'Guadagni e perdite possono coesistere',
    xLabel: 'Corso della vita',
    yLabel: 'Andamento relativo',
    series: [
      {
        name: 'Rapidità',
        points: [
          [0, 0.2],
          [0.48, 0.76],
          [1, 0.43],
        ],
      },
      {
        name: 'Efficacia delle strategie',
        points: [
          [0, 0.13],
          [0.48, 0.49],
          [1, 0.84],
        ],
      },
    ],
    phases: [{ label: 'Età adulta', start: 0.44, end: 0.8 }],
    beats: [
      { action: 'reveal', target: 'Rapidità', label: 'Andamento della rapidità' },
      { action: 'reveal', target: 'Efficacia delle strategie', label: 'Strategie più efficaci' },
      { action: 'phase', target: 'Età adulta', label: 'Fase adulta' },
      {
        action: 'compare',
        target: ['Rapidità', 'Efficacia delle strategie'],
        label: 'Andamenti divergenti',
      },
    ],
  });
  checkTrajectoriesSpec(spec);
  const motion = buildTrajectories(spec, root, [0, 3000, 7000, 10_000]);
  const gap = [...descendants(root)].find(node => node.hasClass('series-gap'));
  assert(gap);
  expect(gap.attrs.d).toMatch(/^M.*Z$/u);
  motion.seek(4, false);
  expect(isVisible(gap)).toBe(false);
  motion.seek(13, false);
  expect(isVisible(gap)).toBe(true);
  motion.seek(4, false);
  expect(isVisible(gap)).toBe(false);
});
