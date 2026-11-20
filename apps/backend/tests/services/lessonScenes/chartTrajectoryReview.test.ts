import { chart } from '@shared/lessonStudios/chart';
import {
  chartViewport,
  readerStudioViewports,
  type StudioViewport,
  studioViewportScale,
  WIDTH,
} from '@shared/lessonStudios/chartDimensions';
import { buildFunctionPlot } from '@shared/lessonStudios/functionPlot';
import { MIN_TEXT_GAP_PX, MIN_TEXT_PX } from '@shared/lessonStudios/layoutValidation';
import { buildTrajectories } from '@shared/lessonStudios/trajectories';
import { boxDistance, isVisible, vectorBounds } from '@shared/lessonStudios/vectorBounds';
import { descendants, type Point, VectorNode } from '@shared/lessonStudios/vectorScene';
import { assert, expect, test } from 'vitest';

function stage(durationMs = 4000, viewport?: StudioViewport) {
  const root = new VectorNode('root', {}, viewport);
  root.data.durationMs = String(durationMs);
  return root;
}

function marks(root: VectorNode, className: string) {
  return [...descendants(root)].filter(node => node.hasClass(className) && isVisible(node));
}

function tickLabels(root: VectorNode, anchor: 'end' | 'middle') {
  return marks(root, 'tick').filter(label => label.attrs['text-anchor'] === anchor);
}

test.each(
  Object.entries(readerStudioViewports)
)('%s keeps neighboring million-scale tick labels distinct on each axis', (_name, viewport) => {
  const root = stage(4000, viewport);
  chart(root, [1000000, 1001000], [1000000, 1001000], 'x', 'y', true);
  for (const anchor of ['middle', 'end'] as const) {
    const labels = tickLabels(root, anchor);
    const values = labels.map(label => label.textContent);
    expect(values.length).toBeGreaterThan(1);
    expect(new Set(values).size).toBe(values.length);
  }
});

test.each(
  Object.entries(readerStudioViewports)
)('%s reserves space for the actual left-axis tick labels', (_name, viewport) => {
  const root = stage(4000, viewport);
  chart(root, [0, 1], [100, 200], 'x', 'y', true);
  const scale = studioViewportScale(viewport);
  const labels = tickLabels(root, 'end');
  expect(labels.length).toBeGreaterThan(1);
  for (const label of labels) {
    const [bounds] = vectorBounds(label);
    expect(bounds.left * scale).toBeGreaterThanOrEqual(MIN_TEXT_GAP_PX);
  }
});

function plotPath(root: VectorNode) {
  const line = [...descendants(root)].find(
    node =>
      !node.hasClass('ghost') &&
      (node.hasClass('chart-line') || node.hasClass('series-gap')) &&
      isVisible(node)
  );
  return String(line?.attrs.d ?? '');
}

function ordinates(path: string) {
  return [...path.matchAll(/[ML][\d.]+,([\d.]+)/gu)].map(match => Number(match[1]));
}

test('an axis that cannot fit its numbers keeps the grid and requests the layout fallback', () => {
  const root = stage(4000, readerStudioViewports.phone);
  const range: Point = [-1.100000000000001e100, -1.1e100];
  const { layers, surface } = chart(root, range, range, 'x', 'y', true);
  expect(layers.number('width')).toBeGreaterThan(0);
  const grid = marks(root, 'grid')[0];
  expect(grid.children.length).toBeGreaterThan(2);
  expect(surface.data.unplacedRequiredLabel).toBe('true');
  for (const [bounds] of marks(root, 'tick').map(vectorBounds)) {
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(WIDTH);
  }
});

test('shows the excursions of 192 sine periods on the release stage', () => {
  const root = stage();
  const motion = buildFunctionPlot(
    {
      family: 'sine',
      xRange: [0, 1],
      yRange: [-1, 1],
      keyframes: [{ params: { amplitude: 1, frequency: 384 * Math.PI, phase: 0 } }],
    },
    root,
    [0]
  );
  motion.seek(0);
  const points = ordinates(plotPath(root));
  const turns = points.filter(
    (value, i) => i > 0 && (value - points[i - 1]) * (points[i + 1] - value) < 0
  );
  expect(Math.max(...points) - Math.min(...points)).toBeGreaterThan(300);
  expect(turns).toHaveLength(384);
});

test.each(
  Object.entries(readerStudioViewports)
)('%s retains the amplitude range when individual periods cannot be resolved', (_name, viewport) => {
  const root = stage(4000, viewport);
  const motion = buildFunctionPlot(
    {
      family: 'sine',
      xRange: [0, 1],
      yRange: [-2, 2],
      keyframes: [
        { params: { amplitude: 1, frequency: 2 * Math.PI, phase: 0 } },
        { params: { amplitude: 1, frequency: 384 * Math.PI, phase: 0 } },
      ],
    },
    root,
    [0, 1000]
  );
  motion.seek(0);
  const original = plotPath(root);
  expect(original).not.toMatch(/Z$/u);
  motion.seek(2);
  const envelope = marks(root, 'series-gap').find(node => !node.hasClass('ghost'));
  assert(envelope?.parent);
  expect(plotPath(root)).toMatch(/Z$/u);
  const points = ordinates(plotPath(root));
  expect(points).toHaveLength(4);
  expect(Math.max(...points) - Math.min(...points)).toBeCloseTo(
    envelope.parent.number('height') / 2,
    2
  );
  const parameter = marks(root, 'parameter')[0];
  const chip = parameter.parent?.children.find(node => node.tag === 'rect');
  assert(chip);
  const [ink] = vectorBounds(parameter);
  expect(ink.top).toBeGreaterThanOrEqual(chip.number('y'));
  expect(ink.bottom).toBeLessThanOrEqual(chip.number('y') + chip.number('height'));
  motion.seek(0);
  expect(plotPath(root)).toBe(original);
});

test('reads the interpolated coefficient in the equation and chip, preserving exact authored endpoints', () => {
  const root = stage();
  const motion = buildFunctionPlot(
    {
      family: 'linear',
      xRange: [-1, 1],
      yRange: [-2, 2],
      keyframes: [{ params: { m: 1, b: 0.00012345 } }, { params: { m: 2, b: 0.00012345 } }],
    },
    root,
    [0, 1000]
  );
  motion.seek(1.25);
  expect(marks(root, 'parameter')[0].textContent).toBe('m = 1,5');
  expect(marks(root, 'equation')[0].textContent).toContain('1,5x');
  motion.seek(2);
  expect(marks(root, 'parameter')[0].textContent).toBe('m = 2');
  expect(marks(root, 'equation')[0].textContent).toContain('0,00012345');
  motion.seek(0);
  expect(marks(root, 'parameter')[0].textContent).toBe('m = 1');
});

test('roots stop marking the axis as soon as the moving parabola has no roots', () => {
  const root = stage();
  const motion = buildFunctionPlot(
    {
      family: 'quadratic',
      xRange: [-2, 2],
      yRange: [-1, 20],
      features: ['roots'],
      keyframes: [{ params: { a: 1, b: 0, c: -1 } }, { params: { a: 1, b: 0, c: 15 } }],
    },
    root,
    [0, 1000]
  );
  motion.seek(1.05);
  expect(marks(root, 'feature')).toHaveLength(2);
  motion.seek(1.2);
  expect(marks(root, 'feature')).toHaveLength(0);
  expect(marks(root, 'feature-tag')).toHaveLength(0);
  motion.seek(1.05);
  expect(marks(root, 'feature')).toHaveLength(2);
});

test.each([false, true])('a terminal cue renders the final pose with reduced=%s', reduced => {
  const root = stage(1000);
  const motion = buildFunctionPlot(
    {
      family: 'linear',
      xRange: [-1, 1],
      yRange: [-3, 3],
      keyframes: [{ params: { m: 1, b: 0 } }, { params: { m: -2, b: 0 } }],
    },
    root,
    [0, 1000]
  );
  motion.seek(0);
  const initial = plotPath(root);
  motion.seek(1, reduced);
  expect(marks(root, 'parameter')[0].textContent).toBe('m = -2');
  expect(plotPath(root)).toMatch(/^M[\d.]+,[\d.]+L/u);
  expect(plotPath(root)).not.toBe(initial);
  motion.seek(0, reduced);
  expect(plotPath(root)).toBe(initial);
});

function trajectory(name: string, y: number) {
  const points: Point[] = [
    [0, 0.5],
    [0.5, 0.5],
    [1, y],
  ];
  return { name, points };
}

test.each(
  Object.entries(readerStudioViewports)
)('%s keeps the top legend entry onstage above five bottom endpoints', (_name, viewport) => {
  const root = stage(6000, viewport);
  const series = [
    trajectory('A', 1),
    ...['B', 'C', 'D', 'E', 'F'].map(name => trajectory(name, 0)),
  ];
  const motion = buildTrajectories(
    { title: 'Andamenti', xLabel: 'Tempo', yLabel: 'Valore', series, beats: [] },
    root,
    []
  );
  motion.seek(3);
  const labels = marks(root, 'series-label');
  const scale = studioViewportScale(viewport);
  expect(labels.map(label => label.textContent)).toEqual(series.map(entry => entry.name));
  expect(marks(root, 'series')).toHaveLength(series.length);
  const boxes = labels.map(label => {
    expect((label.label?.size ?? 0) * scale).toBeGreaterThanOrEqual(MIN_TEXT_PX);
    const [bounds] = vectorBounds(label);
    expect(bounds.top).toBeGreaterThanOrEqual(chartViewport.top);
    expect(bounds.bottom).toBeLessThanOrEqual(chartViewport.top + chartViewport.height);
    const leader = label.parent?.children.find(node => node.hasClass('leader'));
    assert(leader);
    expect(leader.number('y2')).toBeGreaterThanOrEqual(bounds.top);
    expect(leader.number('y2')).toBeLessThanOrEqual(bounds.bottom);
    return bounds;
  });
  for (const [i, bounds] of boxes.entries()) {
    for (const other of boxes.slice(i + 1)) {
      expect(boxDistance(bounds, other) * scale).toBeGreaterThanOrEqual(MIN_TEXT_GAP_PX);
    }
  }
});

test('a short comparison completes both traces and shows the gap before the next beat', () => {
  const root = stage();
  const motion = buildTrajectories(
    {
      title: 'Andamenti',
      xLabel: 'Tempo',
      yLabel: 'Valore',
      series: [trajectory('A', 0.7), trajectory('B', 0.3)],
      phases: [{ label: 'Intervallo', start: 0, end: 1 }],
      beats: [
        { action: 'compare', target: ['A', 'B'] },
        { action: 'phase', target: 'Intervallo' },
        { action: 'reveal', target: 'A' },
        { action: 'reveal', target: 'B' },
      ],
    },
    root,
    [0, 500, 2000, 3000]
  );
  motion.seek(0.49);
  expect(marks(root, 'series-gap')).toHaveLength(1);
  expect(marks(root, 'series').map(path => path.number('stroke-dashoffset'))).toEqual([0, 0]);
  expect(marks(root, 'series-tip')).toHaveLength(2);
  motion.seek(0.8);
  expect(marks(root, 'series-gap')).toHaveLength(0);
  motion.seek(0);
  expect(marks(root, 'series-gap')).toHaveLength(0);
});

test('a legend whose names cannot fit keeps the traces and requests the layout fallback', () => {
  const root = stage(4000, readerStudioViewports.phone);
  const motion = buildTrajectories(
    {
      title: 'Andamenti',
      xLabel: 'Tempo',
      yLabel: 'Valore',
      series: [trajectory('Rapidità', 0.7), trajectory('Efficacia delle strategie', 0.3)],
      beats: [],
    },
    root,
    []
  );
  motion.seek(3);
  expect(marks(root, 'series').map(path => path.number('stroke-dashoffset'))).toEqual([0, 0]);
  expect(marks(root, 'series-tip')).toHaveLength(2);
  expect(root.children[0].data.unplacedRequiredLabel).toBe('true');
});
