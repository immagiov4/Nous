import type { LayoutBounds } from './layoutValidation';
import { StudioLayoutError } from './studioLayoutError';
import {
  absolutePosition,
  descendants,
  labelScaleX,
  type Point,
  shiftBounds,
  type VectorNode,
} from './vectorScene';

export type Box = LayoutBounds;

export function boxDistance(a: Box, b: Box) {
  return Math.hypot(
    Math.max(0, b.left - a.right, a.left - b.right),
    Math.max(0, b.top - a.bottom, a.top - b.bottom)
  );
}

export const overlaps = (a: Box, b: Box) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function vectorOpacity(node: VectorNode) {
  if (node.hasClass('graph-settled-ring') && node.parent?.attrs['data-settled'] !== 'true')
    return 0;
  let opacity = 1;
  for (let current: VectorNode | undefined = node; current; current = current.parent) {
    if (current.tag === 'defs') return 0;
    if (current.attrs.visibility === 'hidden' || current.attrs.display === 'none') return 0;
    opacity *= current.opacity ?? Number(current.attrs.opacity ?? 1);
  }
  return opacity;
}

export const isVisible = (node: VectorNode) => vectorOpacity(node) > 0.01;

function classStrokeWidth(node: VectorNode) {
  if (node.hasClass('chart-line') || node.hasClass('series')) return 4;
  if (node.hasClass('graph-line')) return 2;
  if (node.hasClass('graph-pulse')) return 5;
  if (node.hasClass('graph-settled-ring')) return 2.5;
  if (node.tag === 'rect' && node.parent?.hasClass('graph-node'))
    return node.parent.attrs['data-state'] === 'active' ? 2.5 : 1.7;
  if (node.hasClass('feature')) return 3;
  if (node.hasClass('leader')) return 1.2;
  if (node.hasClass('axis') || node.hasClass('hud-rule')) return 1.25;
  if (node.hasClass('heap-link')) return 2.3;
  if (node.hasClass('array-bar')) return node.parent?.attrs['data-larger'] === 'true' ? 4 : 1;
  return undefined;
}

function strokeWidth(node: VectorNode) {
  if (node.attrs['stroke-width'] !== undefined) return node.number('stroke-width');
  const classWidth = classStrokeWidth(node);
  if (classWidth !== undefined) return classWidth;
  if (node.tag === 'circle') {
    if (node.parent?.attrs['data-larger'] === 'true') return 4;
    return node.parent?.attrs['data-active'] === 'true' ? 2.4 : 1.7;
  }
  if (node.tag === 'line' || node.tag === 'polyline') return 2;
  return node.tag === 'rect' ? 1 : 0;
}

const STROKE_SEGMENT_LENGTH = 8;

function pointBox([x1, y1]: Point, [x2, y2]: Point, pad: number): Box {
  return {
    left: Math.min(x1, x2) - pad,
    top: Math.min(y1, y2) - pad,
    right: Math.max(x1, x2) + pad,
    bottom: Math.max(y1, y2) + pad,
  };
}

function strokeBoxes(points: readonly Point[], pad: number) {
  return points.slice(1).flatMap(([x, y], index) => {
    const [fromX, fromY] = points[index];
    const dx = x - fromX;
    const dy = y - fromY;
    // Sample long diagonal strokes without treating their empty bounding rectangle as ink.
    const count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STROKE_SEGMENT_LENGTH));
    return Array.from({ length: count }, (_, part) =>
      pointBox(
        [fromX + (dx * part) / count, fromY + (dy * part) / count],
        [fromX + (dx * (part + 1)) / count, fromY + (dy * (part + 1)) / count],
        pad
      )
    );
  });
}

function ellipseBoxes(node: VectorNode, pad: number) {
  const rx = node.number('rx');
  const ry = node.number('ry');
  const cx = node.number('cx');
  const cy = node.number('cy');
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(cx) || !Number.isFinite(cy))
    throw new StudioLayoutError('ellipse-nonfinite');
  if (!rx || !ry) return [];
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(cx) || !Number.isFinite(cy))
    throw new StudioLayoutError('ellipse-nonfinite');
  if (!rx || !ry) return [];
  if (node.attrs.fill !== 'none') return [pointBox([cx - rx, cy - ry], [cx + rx, cy + ry], pad)];
  const anglesPerTurn = 2 * Math.PI;
  const steps = Math.ceil((anglesPerTurn * Math.max(rx, ry)) / STROKE_SEGMENT_LENGTH);
  const step = anglesPerTurn / steps;
  return Array.from({ length: steps }, (_, index) => {
    const angle = step * (index + 0.5);
    const point: Point = [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
    return pointBox(point, point, pad + (step * Math.max(rx, ry)) / 2);
  });
}

function polyline(node: VectorNode): Point[] {
  const coords = String(node.attrs.points ?? '')
    .trim()
    .split(/[ ,]+/u)
    .map(Number);
  const points: Point[] = [];
  for (let index = 0; index + 1 < coords.length; index += 2) {
    points.push([coords[index], coords[index + 1]]);
  }
  return points;
}

function lineBoxes(node: VectorNode, pad: number) {
  const start: Point = [node.number('x1'), node.number('y1')];
  const end: Point = [node.number('x2'), node.number('y2')];
  const [before, gap, after] = String(node.attrs['stroke-dasharray'] ?? '')
    .split(' ')
    .map(Number);
  if (node.hasClass('axis') && start[1] === end[1] && gap > 0) {
    // The moving array values reserve a corridor in the axis stroke during a swap.
    const boxes: Box[] = [];
    if (before > 0) boxes.push(pointBox(start, [start[0] + before, start[1]], pad));
    if (after > 0) boxes.push(pointBox([end[0] - after, end[1]], end, pad));
    return boxes;
  }
  if (start[0] === end[0] || start[1] === end[1]) return [pointBox(start, end, pad)];
  return strokeBoxes([start, end], pad);
}

function localBoxes(node: VectorNode): Box[] {
  const pad = strokeWidth(node) / 2;
  const x = node.number('x');
  const y = node.number('y');
  switch (node.tag) {
    case 'text': {
      if (!node.textContent) return [];
      const { bounds, advance, glyphs } = node.glyphs();
      if (!glyphs.length) return [];
      const width = labelScaleX(node, advance);
      return [
        shiftBounds({ ...bounds, left: bounds.left * width, right: bounds.right * width }, [x, y]),
      ];
    }
    case 'rect': {
      const right = x + node.number('width');
      const bottom = y + node.number('height');
      if (!node.hasClass('heap-suffix')) return [pointBox([x, y], [right, bottom], pad)];
      return strokeBoxes(
        [
          [x, y],
          [right, y],
          [right, bottom],
          [x, bottom],
          [x, y],
        ],
        pad
      );
    }
    case 'circle': {
      const radius = node.number('r');
      const cx = node.number('cx');
      const cy = node.number('cy');
      return [pointBox([cx - radius, cy - radius], [cx + radius, cy + radius], pad)];
    }
    case 'line':
      return lineBoxes(node, pad);
    case 'ellipse':
      return ellipseBoxes(node, pad);
    case 'polyline':
      return strokeBoxes(polyline(node), pad);
    default:
      return [];
  }
}

function intersect(a: Box, b: Box): Box {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

export function vectorClip(node: VectorNode, area?: Box) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.tag !== 'svg' || parent.attrs.overflow !== 'hidden') continue;
    const left = parent.number('x');
    const top = parent.number('y');
    const right = left + parent.number('width');
    const bottom = top + parent.number('height');
    const clip = shiftBounds({ left, top, right, bottom }, absolutePosition(parent));
    area = area ? intersect(area, clip) : clip;
  }
  return area;
}

export function vectorBounds(node: VectorNode, clip = true): Box[] {
  const position = absolutePosition(node);
  const boxes = localBoxes(node).map(box => shiftBounds(box, position));
  const area = clip ? vectorClip(node) : undefined;
  return area ? boxes.filter(box => overlaps(box, area)).map(box => intersect(box, area)) : boxes;
}

export function enclosingBoxes(surface: VectorNode) {
  return [...descendants(surface)].flatMap(element => {
    if (!isVisible(element)) return [];
    const boxes = vectorBounds(element);
    return boxes.length ? [{ element, boxes }] : [];
  });
}
