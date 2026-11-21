import type { GeometryLessonScene } from '@shared/lessonScene';
import {
  buildAlgorithmLayout,
  checkAlgorithmGeometry,
} from '@shared/lessonStudios/algorithmLayout';
import { readerStudioViewports, studioViewportScale } from '@shared/lessonStudios/chartDimensions';
import { buildPlane } from '@shared/lessonStudios/plane';
import { planeCopy } from '@shared/lessonStudios/plane.copy.it';
import { compile, roots, sample } from '@shared/lessonStudios/planeMath';
import { checkPlaneSpec, PlaneSpecSchema, type Spec } from '@shared/lessonStudios/planeSpec';
import { isVisible } from '@shared/lessonStudios/vectorBounds';
import { descendants, VectorNode } from '@shared/lessonStudios/vectorScene';
import { assert, expect, test, vi } from 'vitest';

function plane(spec: Partial<Spec>, cues = [0], duration = 3000) {
  const accepted = PlaneSpecSchema.parse({
    title: 'Piano cartesiano',
    x: [-5, 5],
    y: [-2, 2],
    grid: false,
    ...spec,
  });
  checkPlaneSpec(accepted);
  const root = new VectorNode('root');
  root.data.durationMs = String(duration);
  const motion = buildPlane(accepted, root, cues);
  const layer = (id: string) => {
    const group = [...descendants(root)].find(node => node.attrs['data-layer'] === id);
    assert(group);
    return group;
  };
  return { root, layer, ...motion };
}

function visibleCallouts(root: VectorNode) {
  return [...descendants(root)].filter(node => node.hasClass('callout') && isVisible(node));
}

function caption(group: VectorNode) {
  return [...descendants(group)]
    .filter(node => node.tag === 'text')
    .map(node => node.textContent)
    .join(' ')
    .replaceAll(/\s+/gu, ' ');
}

test('rejects a plane oscillation that would alias to a horizontal line', () => {
  const spec = PlaneSpecSchema.parse({
    title: 'Oscillazione',
    x: [0, 1],
    y: [-1, 1],
    scale: 'independent',
    grid: false,
    parameters: { a: 0.5 },
    layers: [{ id: 'wave', type: 'curve', expr: 'a*cos(1507.9644737231006*x)' }],
    beats: [{ focus: ['wave'] }, { focus: ['wave'], set: { a: 1 } }],
  });
  checkPlaneSpec(spec);
  const phrases = ['Osserviamo la curva.', 'Cambia l’ampiezza.'];
  const scene: GeometryLessonScene = {
    type: 'geometry',
    geometryStudio: { id: 'plane', spec },
    narration: phrases.join(' '),
    studioCues: phrases.map(anchor => ({ anchor })),
  };
  const { phone } = readerStudioViewports;
  expect(checkAlgorithmGeometry(scene, phone)).toContain('plot-resolution');
  const layout = buildAlgorithmLayout(scene, phone);
  layout.seek(500);
  const wave = [...descendants(layout.surface)].find(node => node.attrs['data-layer'] === 'wave');
  assert(wave);
  expect(wave.children.some(node => node.tag === 'path' && isVisible(node))).toBe(false);
});

test('seeking back restores a resolved plane curve after an unresolved frequency', () => {
  const drawing = plane(
    {
      x: [0, 1],
      y: [-2, 2],
      parameters: { f: 12 },
      layers: [{ id: 'wave', type: 'curve', expr: 'cos(f*x^2)' }],
      beats: [{ focus: ['wave'] }, { focus: ['wave'], set: { f: 1507.9644737231006 } }],
    },
    [0, 1000]
  );
  const curve = () => drawing.layer('wave').children.find(node => node.tag === 'path');
  drawing.seek(0.5);
  const resolvedPath = curve()?.attrs.d;
  expect(resolvedPath).toEqual(expect.stringContaining('L'));
  drawing.seek(2.9);
  expect(curve()).toBeUndefined();
  drawing.seek(0.5);
  expect(curve()?.attrs.d).toBe(resolvedPath);
});

test.each(
  Object.values(readerStudioViewports)
)('a zero horizon cues convergence with readable text at $width CSS px', viewport => {
  const spec = PlaneSpecSchema.parse({
    title: 'Prospettiva',
    x: [-5, 5],
    y: [-2, 2],
    grid: false,
    parameters: { x1: -2 },
    layers: [
      {
        id: 'ray',
        type: 'construction',
        through: [
          ['x1', -1],
          [-1, -0.5],
        ],
        horizon: 0,
      },
    ],
    beats: [
      { focus: ['ray'], callout: true },
      { focus: ['ray'], set: { x1: -3 } },
    ],
  });
  checkPlaneSpec(spec);
  const phrases = [
    'Le linee convergono verso l’orizzonte.',
    'Ora cambia la direzione della linea.',
  ];
  const scene: GeometryLessonScene = {
    type: 'geometry',
    geometryStudio: { id: 'plane', spec },
    narration: phrases.join(' '),
    studioCues: phrases.map(anchor => ({ anchor })),
  };
  const layout = buildAlgorithmLayout(scene, viewport);
  layout.seek(700);
  const [callout] = visibleCallouts(layout.surface);
  assert(callout);
  expect(caption(callout)).toBe(planeCopy.direction);
  for (const text of [...descendants(callout)].filter(node => node.tag === 'text')) {
    assert(text.label);
    expect(text.label.size * studioViewportScale(viewport)).toBeGreaterThanOrEqual(14);
  }
  const marks = [...descendants(layout.surface)].filter(
    node => node.tag === 'path' && node.parent?.attrs['data-layer'] === 'ray' && isVisible(node)
  );
  expect(marks).toHaveLength(1);
  expect(checkAlgorithmGeometry(scene, viewport)).toEqual([]);
});

test('the generated Snell callout follows the current ray through the critical angle', () => {
  const scene = plane(
    {
      parameters: { incidence: 45 },
      layers: [{ id: 'ray', type: 'snell', n1: 1.33, n2: 1, angle: 'incidence' }],
      beats: [{ focus: ['ray'] }, { focus: ['ray'], set: { incidence: 55 }, callout: true }],
    },
    [0, 1000]
  );
  const callouts = () => visibleCallouts(scene.root).map(caption);
  const rayLabels = () =>
    scene
      .layer('ray')
      .children.filter(isVisible)
      .map(node => node.textContent);
  scene.seek(1.1);
  expect(rayLabels().some(label => label.startsWith('θ₂'))).toBe(true);
  expect(callouts()).toEqual([planeCopy.away]);
  scene.seek(1.45);
  expect(rayLabels().some(label => label.startsWith('θ₂') || label === planeCopy.total)).toBe(
    false
  );
  expect(callouts()).toEqual([planeCopy.total]);
  scene.seek(1.1);
  expect(callouts()).toEqual([planeCopy.away]);
});

test('a late final cue settles motion and emphasis by the end of playback', () => {
  const scene = plane(
    {
      parameters: { x1: -1 },
      layers: [{ id: 'point', type: 'point', at: ['x1', 0] }],
      beats: [
        { focus: ['point'], show: [] },
        { focus: ['point'], show: ['point'], set: { x1: 1 }, label: 'Punto' },
      ],
    },
    [0, 950],
    1000
  );
  function lastFrame(reduced: boolean) {
    scene.seek(1, reduced);
    const group = scene.layer('point');
    const [callout] = visibleCallouts(scene.root);
    return {
      pointX: group.children.find(node => node.tag === 'circle')?.number('cx'),
      opacity: group.number('opacity'),
      calloutOpacity: callout?.number('opacity'),
      calloutOffset: callout?.y,
    };
  }
  const settled = lastFrame(true);
  expect(settled.pointX).toBeGreaterThan(499);
  expect(settled.opacity).toBe(1);
  expect(lastFrame(false)).toEqual(settled);
  expect(settled.calloutOpacity).toBe(1);
  expect(settled.calloutOffset).toBe(0);
  expect(Math.max(...scene.cuts)).toBe(1);
});

test('reduced motion shows a settled callout exactly at its narration cue', () => {
  const scene = plane(
    {
      layers: [{ id: 'point', type: 'point', at: [1, 1] }],
      beats: [{ focus: ['point'] }, { focus: ['point'], label: 'Punto' }],
    },
    [0, 1000]
  );
  scene.seek(0.999, true);
  expect(visibleCallouts(scene.root)).toEqual([]);
  scene.seek(1, true);
  const [callout] = visibleCallouts(scene.root);
  assert(callout);
  expect(caption(callout)).toBe('Punto');
  expect(callout.number('opacity')).toBe(1);
  expect(callout.y).toBe(0);
});

test.each<Spec['layers'][number]>([
  {
    id: 'guide',
    type: 'construction',
    through: [
      [-1, -0.5],
      [1, 0.5],
    ],
    name: 'Guida obliqua',
  },
  {
    id: 'guide',
    type: 'construction',
    through: [
      [1, -1],
      [1, 1],
    ],
    name: 'Guida verticale',
  },
])('a boundary-spanning construction keeps its name ($name)', construction => {
  const scene = plane({ layers: [construction], beats: [{ focus: ['guide'] }] });
  scene.seek(1);
  const marks = scene.layer('guide').children.filter(isVisible);
  expect(marks.some(node => node.tag === 'path')).toBe(true);
  expect(marks.find(node => node.hasClass('plane-label'))?.textContent).toBe(construction.name);
});

test.each([
  { expr: 'sqrt(x)', left: -1, count: 1 },
  { expr: 'sqrt(x^2-1)', left: -3, count: 2 },
])('shading fills each finite portion of $expr against a line', ({ expr, left, count }) => {
  const scene = plane({
    x: [left, 4],
    y: [-2, 5],
    layers: [
      { id: 'curve', type: 'curve', expr },
      { id: 'line', type: 'line', form: { m: 0, b: -1 } },
      { id: 'fill', type: 'region', between: ['curve', 'line'], where: 'above' },
    ],
    beats: [{ focus: ['fill'] }],
  });
  scene.seek(1);
  const polygons = scene.layer('fill').children.filter(node => node.tag === 'path');
  expect(polygons).toHaveLength(count);
  for (const polygon of polygons) {
    const points = String(polygon.attrs.d);
    expect(points).not.toMatch(/NaN|Infinity/u);
    expect(points).toMatch(/^M.+ L.+ L.+Z$/u);
  }
});

test('a translated grid visits representable coordinates and finishes at large offsets', () => {
  const start = 1e16;
  const scene = plane({
    x: [start, start + 16],
    y: [-2, 2],
    layers: [
      {
        id: 'grid',
        type: 'grid-transform',
        matrix: [
          [1, 0],
          [0, 1],
        ],
      },
    ],
    beats: [{ focus: ['grid'] }],
  });
  const group = scene.layer('grid');
  const append = group.append.bind(group);
  const spy = vi.spyOn(group, 'append').mockImplementation(node => {
    // Bound the test itself if floating-point iteration gets stuck on one line.
    if (group.children.length >= 32) throw new Error('Grid repeats beyond its lattice');
    append(node);
  });
  try {
    scene.seek(1);
    const strokes = group.children
      .filter(node => node.attrs.stroke === 'var(--rule)')
      .map(node => node.attrs.d);
    expect(strokes).toHaveLength(14);
    expect(new Set(strokes).size).toBe(strokes.length);
  } finally {
    spy.mockRestore();
  }
});

test('a discontinuous boundary shades only the side that satisfies the inequality', () => {
  const scene = plane({
    x: [-1, 1],
    parameters: { a: 0.247 },
    layers: [
      { id: 'step', type: 'curve', expr: '1e-9*(x-a)/abs(x-a)' },
      { id: 'axis', type: 'line', form: { m: 0, b: 0 } },
      { id: 'fill', type: 'region', between: ['step', 'axis'], where: 'above' },
    ],
    beats: [{ focus: ['fill'] }],
  });
  scene.seek(1);
  const verticalAxis = [...descendants(scene.root)].find(
    node => node.hasClass('axis') && node.number('x1') === node.number('x2')
  );
  assert(verticalAxis);
  const [fill] = scene.layer('fill').children;
  assert(fill);
  const xCoordinates = [...String(fill.attrs.d).matchAll(/[ML]([^ ]+) /gu)].map(match =>
    Number(match[1])
  );
  expect(Math.min(...xCoordinates)).toBeGreaterThan(verticalAxis.number('x1'));
});

test('curve expressions separate tokens across whitespace', () => {
  expect(compile('  1e-2 + sqrt ( x ) ', [])(4, {})).toBe(2.01);
  for (const expression of ['1 2', '1 e2', 's qrt(x)', '1. 2']) {
    expect(() => compile(expression, [])).toThrow();
  }
});

test('small discontinuous sign jumps do not create zero markers', () => {
  const domain = sample([-1, 1]);
  const step = compile('1e-9*(x-a)/abs(x-a)', ['a']);
  const continuous = compile('1e-9*(x-a)', ['a']);
  const a = 0.247;
  expect(roots(x => step(x, { a }), domain)).toEqual([]);
  expect(roots(x => continuous(x, { a }), domain)).toEqual([expect.closeTo(a, 8)]);
  expect(roots(x => continuous(x, { a: 1e-13 }), domain)).toEqual([expect.closeTo(1e-13, 14)]);
});

test.each([0.25, 239.75])('the plane detects a touching root at %s in an edge interval', at => {
  expect(roots(x => (x - at) ** 2, sample([0, 240]))).toEqual([expect.closeTo(at, 6)]);
});
