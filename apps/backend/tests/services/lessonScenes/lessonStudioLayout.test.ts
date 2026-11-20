import { chart, fitLabel, textAt } from '@shared/lessonStudios/chart';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { buildFunctionPlot } from '@shared/lessonStudios/functionPlot';
import { placeDiagramLabels } from '@shared/lessonStudios/labelPlacement';
import {
  checkStudioLayout,
  hasDeadStage,
  type StudioLayout,
} from '@shared/lessonStudios/layoutValidation';
import { buildPlane } from '@shared/lessonStudios/plane';
import { checkPlaneSpec, PlaneSpecSchema } from '@shared/lessonStudios/planeSpec';
import { MIN_TRACE_MOVE, tracePlayback } from '@shared/lessonStudios/stagedTrace';
import { studioTextShape } from '@shared/lessonStudios/studioTypography';
import { isVisible, overlaps, vectorBounds } from '@shared/lessonStudios/vectorBounds';
import { descendants, svg, VectorNode } from '@shared/lessonStudios/vectorScene';
import { expect, test } from 'vitest';

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

function layout(frame: StudioLayout['frames'][number]): StudioLayout {
  return { stage: bounds(0, 0, 200, 120), frames: [frame] };
}

test('accepts a readable label whose closest mark is the one it names', () => {
  expect(
    checkStudioLayout(
      layout({
        axisScale: { x: 10, y: 10 },
        elements: [
          { id: 'point-a', bounds: bounds(50, 65, 54, 69) },
          {
            id: 'label-a',
            bounds: bounds(45, 30, 80, 47),
            label: { fontPx: 16, anchorId: 'point-a' },
          },
          { id: 'point-b', bounds: bounds(115, 65, 119, 69) },
        ],
      })
    )
  ).toEqual([]);
});

test('rejects undersized and overlapping labels, a wrong visual anchor and a stretched geometric scale', () => {
  expect(
    checkStudioLayout(
      layout({
        axisScale: { x: 10, y: 5 },
        elements: [
          { id: 'point-a', bounds: bounds(50, 35, 54, 39) },
          {
            id: 'label-a',
            bounds: bounds(45, 30, 80, 47),
            label: { fontPx: 12, anchorId: 'point-b' },
          },
          { id: 'point-b', bounds: bounds(115, 65, 119, 69) },
        ],
      })
    )
  ).toEqual(
    expect.arrayContaining(['axis-scale', 'min-text', 'overlap', 'min-gap', 'label-association'])
  );
});

test('the text clearance catches a near miss without an intersection', () => {
  expect(
    checkStudioLayout(
      layout({
        elements: [
          { id: 'point', bounds: bounds(50, 54, 54, 58) },
          { id: 'label', bounds: bounds(45, 30, 80, 47), label: { fontPx: 14 } },
        ],
      })
    )
  ).toEqual(['min-gap']);
});

test('rejects missing layout evidence', () => {
  expect(checkStudioLayout(undefined)).toEqual(['layout-unavailable']);
});

test('a short last move shares the previous move at an exact narration pin', () => {
  const root = new VectorNode('root');
  const times = tracePlayback(
    root,
    4,
    [
      { index: 0, time: 0.01 },
      { index: 3, time: 1.95 },
    ],
    2.05
  );
  expect(times[3]).toBe(1.95);
  const moves: { start: number; end: number; steps: number }[] = JSON.parse(root.data.traceMoves);
  expect(moves.at(-1)?.steps).toBe(2);
  expect(moves.every(move => move.end - move.start >= MIN_TRACE_MOVE)).toBe(true);
});

test('an ellipse with a non-finite radius reports a diagnostic instead of disappearing', () => {
  const root = new VectorNode('root');
  const ellipse = svg(root, 'ellipse', { rx: NaN, ry: 10 });
  expect(() => vectorBounds(ellipse)).toThrowError(
    expect.objectContaining({
      code: 'ellipse-nonfinite',
    })
  );
  ellipse.setAttribute('rx', 0);
  expect(vectorBounds(ellipse)).toEqual([]);
});

test('fitting a short readout clears the full-text label from a previous abbreviation', () => {
  const root = new VectorNode('root', {}, readerStudioViewports.phone);
  const label = textAt(root, 0, 0, '');
  const full = 'Una descrizione particolarmente lunga';
  fitLabel(label, full, 120, 1);
  expect(label.attrs['aria-label']).toBe(full);
  fitLabel(label, 'a = 1', 120, 1);
  expect(label.textContent).toBe('a = 1');
  expect(label.attrs['aria-label']).toBeUndefined();
});

test('multiline ink keeps an empty row’s baseline spacing without counting that row as paint', () => {
  const single = studioTextShape('Raggio', 'plane-label', 'end');
  const multiline = studioTextShape('Raggio\n ', 'plane-label', 'end');
  expect(multiline.bounds.right).toBe(single.bounds.right);
  expect(multiline.bounds.bottom - multiline.bounds.top).toBeCloseTo(
    single.bounds.bottom - single.bounds.top
  );
  expect(multiline.bounds.bottom).toBeLessThan(single.bounds.bottom);
  expect(studioTextShape(' \n ', 'plane-label', 'end').bounds).toEqual(bounds(0, 0, 0, 0));
});

test('a required diagram label may not move outside its plot to escape a filled mark', () => {
  const root = new VectorNode('root', {}, readerStudioViewports.phone);
  const { surface, layers, area } = chart(root, [-1, 1], [-1, 1], '', '', false);
  const { left, top, right, bottom } = area;
  const label = textAt(
    layers,
    (left + right) / 2,
    (top + bottom) / 2,
    'Regione',
    'middle',
    'plane-label'
  );
  const region = svg(layers, 'path', {
    d: `M ${left} ${top} H ${right} V ${bottom} H ${left} Z`,
    fill: 'red',
  });
  expect(vectorBounds(region).some(box => overlaps(box, vectorBounds(label)[0]))).toBe(true);
  placeDiagramLabels(surface, ['plane-label'], bounds(0, 0, 1000, 465), () => false);
  expect(isVisible(label)).toBe(false);
  expect(surface.data.unplacedRequiredLabel).toBe('true');
});

test('the computed geometric chart keeps one unit equally long on both axes', () => {
  const root = new VectorNode('root');
  const { surface, x, y } = chart(root, [-1.3, 8], [-1.25, 1.25], 'x', 'y', true, true);
  expect(Math.abs(x(1) - x(0))).toBeCloseTo(Math.abs(y(1) - y(0)), 9);
  expect(Number(surface.data.planeUnitX)).toBeCloseTo(Number(surface.data.planeUnitY), 9);
});

test('a unit circle in a wide plane keeps its circular shape', () => {
  const root = new VectorNode('root');
  root.data.durationMs = '3000';
  const spec = PlaneSpecSchema.parse({
    title: 'Cerchio unitario',
    x: [-1.3, 8],
    y: [-1.25, 1.25],
    grid: false,
    layers: [{ id: 'unit', type: 'circle', center: [0, 0], radius: 1 }],
    beats: [{ focus: ['unit'] }],
  });
  checkPlaneSpec(spec);
  const motion = buildPlane(spec, root, [0]);
  motion.seek(1);
  const shape = [...descendants(root)].find(node => node.tag === 'ellipse');
  expect(shape?.number('rx')).toBeGreaterThan(0);
  expect(shape?.number('rx')).toBeCloseTo(shape?.number('ry') ?? 0, 9);
  expect(() => checkPlaneSpec({ ...spec, scale: 'independent' })).toThrow(
    'Geometric layers require scale: equal'
  );
});

test('a function plot draws its requested coefficient again after a backward seek', () => {
  const root = new VectorNode('root');
  root.data.durationMs = '2000';
  const motion = buildFunctionPlot(
    {
      family: 'quadratic',
      xRange: [-2, 2],
      yRange: [-5, 5],
      keyframes: [{ params: { a: 1, b: 0, c: 0 } }, { params: { a: -1, b: 0, c: 0 } }],
    },
    root,
    [0, 1000]
  );
  const nodes = [...descendants(root)];
  const curve = nodes.find(node => node.hasClass('chart-line') && !node.hasClass('ghost'));
  const coefficient = nodes.find(node => node.hasClass('parameter'));
  motion.seek(0);
  const original = curve?.attrs.d;
  expect(original).toMatch(/^M/u);
  expect(coefficient?.textContent).toBe('a = 1');
  motion.seek(1.75);
  expect(coefficient?.textContent).toBe('a = -1');
  expect(curve?.attrs.d).not.toBe(original);
  motion.seek(0);
  expect(coefficient?.textContent).toBe('a = 1');
  expect(curve?.attrs.d).toBe(original);
});

test('checks for an empty opening and for uncovered time before, between and after motion', () => {
  const timing = {
    firstMeaningfulMs: 900,
    durationMs: 8500,
    active: [{ startMs: 3000, endMs: 4600 }],
  };
  expect(hasDeadStage(timing)).toBe(false);
  expect(hasDeadStage({ ...timing, firstMeaningfulMs: 2001 })).toBe(true);
  expect(hasDeadStage({ ...timing, durationMs: 8601 })).toBe(true);
  expect(hasDeadStage({ ...timing, active: [{ startMs: 5000, endMs: 8500 }] })).toBe(true);
});
