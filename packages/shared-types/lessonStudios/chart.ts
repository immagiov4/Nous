import { scaleLinear } from 'd3';
import { rememberCallout } from './callouts';
import { HEIGHT, studioAnchors, studioStage, WIDTH } from './chartDimensions';
import { MIN_TEXT_GAP_PX, MIN_TEXT_PX } from './layoutValidation';
import { StudioLayoutError } from './studioLayoutError';
import {
  type StudioAnchor,
  type StudioTextStyle,
  studioTextShape,
  studioTypeStyles,
} from './studioTypography';
import { type Box, boxDistance, vectorBounds } from './vectorBounds';
import { type Point, svg, type VectorNode } from './vectorScene';

export const plotArea = { left: 56, right: 954, top: 49, bottom: 421 };
const number = new Intl.NumberFormat('it-IT', { maximumSignificantDigits: 4 });
const format = (n: number) => number.format(Object.is(n, -0) ? 0 : n);
/** Keep the shortest round-trip decimal for operands compared at full precision. */
export const formatOperand = (n: number) => String(n).replace('.', ',');
const derivedNumber = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 });
export const derived = (n: number) => {
  const label = derivedNumber.format(n);
  return label === '-0' ? '0' : label;
};

export function derivedFormatter(finalValue: number) {
  const places =
    derivedNumber.formatToParts(finalValue).find(part => part.type === 'fraction')?.value.length ??
    0;
  const format = new Intl.NumberFormat('it-IT', { maximumFractionDigits: places });
  return (number: number) => {
    const label = format.format(number);
    return label === '-0' ? '0' : label;
  };
}
/** Keep a horizontal rule visible outside the span reserved for a moving item. */
export function ruleOutsideSpan(start: number, end: number, left: number, right: number) {
  const spanStart = Math.max(start, Math.min(end, left));
  const spanEnd = Math.max(spanStart, Math.min(end, right));
  return [spanStart - start, spanEnd - spanStart, end - spanEnd, 0].join(' ');
}

export function textAt(
  parent: VectorNode,
  x: number,
  y: number,
  label: string,
  anchor: StudioAnchor = 'middle',
  className: StudioTextStyle = 'tick'
) {
  const text = svg(parent, 'text', { x, y, 'text-anchor': anchor, class: className });
  const size = parent.viewport ? MIN_TEXT_PX : studioTypeStyles[className][0];
  text.label = { style: className, anchor, size };
  text.textContent = label;
  return text;
}

export function placeTextAbove(node: VectorNode, limit: number) {
  const [ink] = vectorBounds(node);
  if (ink) node.setAttribute('y', node.number('y') + limit - ink.bottom);
}

const MAX_PILL_ROWS = 2;
const graphemes = new Intl.Segmenter('it', { granularity: 'grapheme' });

function fitText(node: VectorNode, value: string, width: number) {
  node.textContent = value;
  if (!node.label) throw new StudioLayoutError('missing-label-style');
  node.removeAttribute('aria-label');
  const length = node.glyphs().advance;
  if (length <= width) return true;
  const size = node.label.size;
  if (!node.viewport)
    node.label.size = Math.max(Math.min(size, MIN_TEXT_PX), Math.floor((size * width) / length));
  if (node.glyphs().advance <= width) return true;

  const parts = Array.from(graphemes.segment(value), part => part.segment);
  let low = 0,
    high = parts.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    node.textContent = `${parts.slice(0, mid).join('').trimEnd()}…`;
    if (node.glyphs().advance <= width) low = mid;
    else high = mid - 1;
  }
  node.textContent = `${parts.slice(0, low).join('').trimEnd()}…`;
  node.setAttribute('aria-label', value);
  return false;
}

/** Centre up to two measured lines before reducing the size to fit. */
export function fitLabel(node: VectorNode, value: string, width: number, rows = 2) {
  const label = node.label;
  if (!label) throw new StudioLayoutError('missing-label-style');
  node.removeAttribute('aria-label');
  node.textContent = value;
  if (node.glyphs().advance <= width) return true;
  const words = value.split(/\s+/u);
  if (rows === 1 || words.length < 2) return fitText(node, value, width);
  const advance = (line: string) =>
    studioTextShape(line, label.style, label.anchor, label.size).advance;
  let preferred = [value];
  let shortest = Infinity;
  for (let split = 1; split < words.length; split++) {
    const candidate = [words.slice(0, split).join(' '), words.slice(split).join(' ')];
    const longest = Math.max(...candidate.map(advance));
    if (longest >= shortest) continue;
    preferred = candidate;
    shortest = longest;
  }
  if (!node.viewport)
    label.size = Math.max(
      MIN_TEXT_PX,
      Math.min(label.size, Math.floor((label.size * width) / shortest))
    );
  node.textContent = preferred.join('\n');
  if (node.glyphs().advance > width) return fitText(node, value, width);
  node.setAttribute('aria-label', value);
  return true;
}

export function diagram(root: VectorNode, label: string) {
  const { top, width, height } = studioStage(root.viewport);
  return svg(root, 'svg', {
    viewBox: `0 ${top} ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': label,
  });
}

type Range = [number, number];

const compactNumber = new Intl.NumberFormat('it-IT', {
  maximumSignificantDigits: 3,
  notation: 'compact',
});

// Seventeen significant digits distinguish any two finite double-precision values.
const scientificNumber = new Intl.NumberFormat('it-IT', {
  maximumSignificantDigits: 17,
  notation: 'scientific',
});

function labelTicks(values: number[], prefer: (value: number) => string) {
  const labels = values.map(prefer);
  return new Set(labels).size === labels.length
    ? labels
    : values.map(value => scientificNumber.format(value));
}

function axesLayout(root: VectorNode, numeric: boolean, xTicks: number[], yTicks: number[]) {
  const { x, y } = studioAnchors(root.viewport);
  const standard = {
    left: x(plotArea.left),
    right: x(numeric ? plotArea.right : 795),
    top: y(plotArea.top),
    bottom: y(plotArea.bottom),
  };
  if (!root.viewport)
    return {
      area: standard,
      unplacedTicks: false,
      xLabels: labelTicks(xTicks, format),
      yLabels: labelTicks(yTicks, format),
      xOffset: 22,
      yOffset: 10,
      axisLabelY: HEIGHT - 5,
    };
  const { width, bottom } = studioStage(root.viewport);
  const font = MIN_TEXT_PX;
  const gap = MIN_TEXT_GAP_PX;
  const textWidth = (value: string) => studioTextShape(value, 'tick', 'middle', font).advance;
  const tickText = (value: number) => {
    const full = format(value);
    if (textWidth(full) + 2 * gap <= standard.left) return full;
    const short = compactNumber.format(value);
    return textWidth(short) < textWidth(full) ? short : full;
  };
  const xLabels = labelTicks(xTicks, tickText);
  const yLabels = labelTicks(yTicks, tickText);
  const xInk = xLabels.map(label => studioTextShape(label, 'tick', 'middle', font).bounds);
  const leftTick = Math.max(
    0,
    ...yLabels.map(label => -studioTextShape(label, 'tick', 'end', font).bounds.left)
  );
  const leftXTick = Math.max(0, ...xInk.map(bounds => -bounds.left));
  const rightTick = Math.max(0, ...xInk.map(bounds => bounds.right));
  const area = {
    left: Math.max(standard.left, leftTick + 2 * gap + 1, leftXTick + gap),
    right: Math.min(standard.right, width - rightTick - gap),
    top: Math.max(standard.top, font + 2 * gap),
    bottom: Math.min(standard.bottom, bottom - 2 * gap - (numeric ? 2 * font : font)),
  };
  const unplacedTicks = area.left >= area.right || area.top >= area.bottom;
  return {
    area: unplacedTicks ? standard : area,
    unplacedTicks,
    xLabels,
    yLabels,
    xOffset: gap + font + 1,
    yOffset: gap + 1,
    axisLabelY: bottom - gap,
  };
}

function thinTicks(
  labels: VectorNode[],
  axisLabels: VectorNode[],
  stage: ReturnType<typeof studioStage>
) {
  const occupied: Box[] = axisLabels.flatMap(node => vectorBounds(node));
  for (const label of labels) {
    const [bounds] = vectorBounds(label);
    if (!bounds) continue;
    const outside =
      bounds.left < 0 ||
      bounds.right > stage.width ||
      bounds.top < stage.top ||
      bounds.bottom > stage.bottom;
    if (outside || occupied.some(other => boxDistance(bounds, other) < MIN_TEXT_GAP_PX))
      label.setAttribute('visibility', 'hidden');
    else occupied.push(bounds);
  }
}

/** Build the lab chart's axes and clipping viewport in the shared layout. */
export function chart(
  root: VectorNode,
  xRange: Range,
  yRange: Range,
  xLabel: string,
  yLabel: string,
  numeric: boolean,
  equal = false
) {
  const x = scaleLinear().domain(xRange);
  const y = scaleLinear().domain(yRange);
  const xTicks = x.ticks(numeric ? 8 : 5);
  const yTicks = y.ticks(numeric ? 7 : 4);
  const {
    area: limits,
    xLabels,
    yLabels,
    xOffset,
    yOffset,
    unplacedTicks,
    axisLabelY,
  } = axesLayout(root, numeric, numeric ? xTicks : [], numeric ? yTicks : []);
  const { left, right, top, bottom } = limits;
  const width = right - left;
  const height = bottom - top;
  const dx = xRange[1] - xRange[0];
  const dy = yRange[1] - yRange[0];
  const unit = Math.min(width / dx, height / dy);
  const insetX = equal ? Math.max(0, (width - unit * dx) / 2) : 0;
  const insetY = equal ? Math.max(0, (height - unit * dy) / 2) : 0;
  const area = {
    left: left + insetX,
    right: right - insetX,
    top: top + insetY,
    bottom: bottom - insetY,
  };
  x.range([area.left, area.right]);
  y.range([area.bottom, area.top]);
  const surface = diagram(root, `${yLabel} per ${xLabel}`);
  if (unplacedTicks) surface.data.unplacedRequiredLabel = 'true';
  const grid = svg(surface, 'g', { class: 'grid' });
  const ticks: VectorNode[] = [];
  for (const [index, value] of xTicks.entries()) {
    svg(grid, 'line', { x1: x(value), x2: x(value), y1: area.top, y2: area.bottom });
    if (numeric) ticks.push(textAt(surface, x(value), area.bottom + xOffset, xLabels[index]));
  }
  for (const [index, value] of yTicks.entries()) {
    svg(grid, 'line', { x1: area.left, x2: area.right, y1: y(value), y2: y(value) });
    if (numeric)
      ticks.push(textAt(surface, area.left - yOffset, y(value) + 4, yLabels[index], 'end'));
  }
  const axisX = x(Math.max(xRange[0], Math.min(xRange[1], 0)));
  const axisY = y(Math.max(yRange[0], Math.min(yRange[1], 0)));
  svg(surface, 'line', { class: 'axis', x1: area.left, x2: area.right, y1: axisY, y2: axisY });
  svg(surface, 'line', { class: 'axis', x1: axisX, x2: axisX, y1: area.top, y2: area.bottom });
  const stage = studioStage(root.viewport);
  const axisNames = [
    textAt(surface, area.left, area.top - Math.max(yOffset, 13), yLabel, 'start', 'axis-label'),
    textAt(surface, area.right, axisLabelY, xLabel, 'end', 'axis-label'),
  ];
  if (root.viewport) {
    placeTextAbove(axisNames[0], area.top - 2 - MIN_TEXT_GAP_PX);
    placeTextAbove(axisNames[1], stage.bottom - 2);
    thinTicks(ticks, axisNames, stage);
  }
  const layers = svg(surface, 'svg', {
    x: left,
    y: top,
    width,
    height,
    viewBox: [left, top, width, height].join(' '),
    overflow: 'hidden',
  });
  if (equal) {
    surface.data.equalScale = 'true';
    surface.data.planeUnitX = String(Math.abs(area.right - area.left) / dx);
    surface.data.planeUnitY = String(Math.abs(area.bottom - area.top) / dy);
  }
  return { surface, layers, x, y, area };
}

/** Measure wrapped text once. Position the pill separately from its leader so both can follow a data point. */
export function pill(parent: VectorNode, label: string, className = '') {
  const group = svg(parent, 'g', { class: `pill ${className}` });
  const leader = svg(group, 'polyline', { class: 'leader', fill: 'none' });
  const body = svg(group, 'g', {});
  const rect = svg(body, 'rect', { rx: 16 });
  const text = svg(body, 'g', {});
  const stage = studioStage(parent.viewport);
  const { width, height } = parent.viewport
    ? adaptivePillText(text, label, stage.width)
    : labPillText(text, label);
  rect.setAttribute('width', String(width));
  rect.setAttribute('height', String(height));
  rect.setAttribute('x', String(-width / 2));
  rect.setAttribute('y', String(-height / 2));
  return {
    group,
    width,
    height,
    place([targetX, targetY]: Point, [desiredX, desiredY]: Point) {
      const x = Math.min(stage.width - width / 2 - 8, Math.max(width / 2 + 8, desiredX));
      const y = Math.min(
        (parent.viewport ? stage.bottom : HEIGHT) - height / 2 - 8,
        Math.max(height / 2 + 8, desiredY)
      );
      rememberCallout(group, {
        target: [targetX, targetY],
        desired: [desiredX, desiredY],
        initial: [x, y],
        body,
        leader,
        width,
        height,
      });
      body.x = x;
      body.y = y;
      leader.setAttribute('points', `${targetX},${targetY} ${x},${y}`);
    },
  };
}

const PILL_LINE_WIDTH = 258;

function adaptivePillText(parent: VectorNode, label: string, stageWidth: number) {
  const text = textAt(parent, 0, 0, label, 'middle', 'pill-text');
  const pad = MIN_TEXT_GAP_PX;
  fitLabel(text, label, Math.min(PILL_LINE_WIDTH, stageWidth - 4 * pad));
  const { advance, bounds } = text.glyphs();
  text.setAttribute('y', -(bounds.top + bounds.bottom) / 2);
  return { width: advance + 2 * pad, height: bounds.bottom - bounds.top + 2 * pad };
}

function labPillText(text: VectorNode, label: string) {
  const maxLine = PILL_LINE_WIDTH;
  const leading = 19;
  let row = textAt(text, 0, 0, '', 'middle', 'pill-text');
  const rows = [row];
  const words = label.split(/\s+/u);
  for (const [index, word] of words.entries()) {
    if (rows.length === MAX_PILL_ROWS && words.length > 4) {
      fitText(row, [row.textContent, ...words.slice(index)].filter(Boolean).join(' '), maxLine);
      text.setAttribute('aria-label', label);
      break;
    }
    const previous = row.textContent;
    row.textContent = previous ? `${previous} ${word}` : word;
    if (previous && row.glyphs().advance > maxLine) {
      row.textContent = previous;
      row = textAt(text, 0, 5 + leading / 2, '', 'middle', 'pill-text');
      row.textContent = word;
      rows.push(row);
    }
    if (row.glyphs().advance > maxLine) {
      fitText(row, row.textContent ?? '', maxLine);
    }
  }
  const width =
    Math.ceil(Math.max(...rows.map(row => Math.min(maxLine, row.glyphs().advance)))) + 28;
  const height = 32 + (rows.length - 1) * leading;
  rows[0].setAttribute('y', String(5 - ((rows.length - 1) * leading) / 2));
  return { width, height };
}
