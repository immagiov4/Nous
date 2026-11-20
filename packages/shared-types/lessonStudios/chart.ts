import { scaleLinear } from 'd3';
import { rememberCallout } from './callouts';
import { chartViewport, HEIGHT, studioViewportScale, WIDTH } from './chartDimensions';
import { MIN_TEXT_GAP_PX, MIN_TEXT_PX } from './layoutValidation';
import { StudioLayoutError } from './studioLayoutError';
import {
  type StudioAnchor,
  type StudioTextStyle,
  studioTextShape,
  studioTypeStyles,
} from './studioTypography';
import { type Point, svg, type VectorNode } from './vectorScene';

/** Keep the shortest round-trip decimal for operands compared at full precision. */
export const formatOperand = (n: number) => String(n).replace('.', ',');
/** Keep a horizontal rule visible outside the span reserved for a moving item. */
export function ruleOutsideSpan(start: number, end: number, left: number, right: number) {
  return [Math.max(0, left - start), right - left, Math.max(0, end - right), 0].join(' ');
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
  const size = parent.viewport
    ? Math.ceil(MIN_TEXT_PX / studioViewportScale(parent.viewport))
    : studioTypeStyles[className][0];
  text.label = { style: className, anchor, size };
  text.textContent = label;
  return text;
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
  return svg(root, 'svg', {
    viewBox: `0 ${chartViewport.top} ${WIDTH} ${chartViewport.height}`,
    class: 'chart',
    role: 'img',
    'aria-label': label,
  });
}

type Range = [number, number];

/** Measure wrapped text once. Position the pill separately from its leader so both can follow a data point. */
export function pill(parent: VectorNode, label: string, className = '') {
  const group = svg(parent, 'g', { class: `pill ${className}` });
  const leader = svg(group, 'polyline', { class: 'leader', fill: 'none' });
  const body = svg(group, 'g', {});
  const rect = svg(body, 'rect', { rx: 16 });
  const text = svg(body, 'g', {});
  const { width, height } = parent.viewport
    ? adaptivePillText(text, label, studioViewportScale(parent.viewport))
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
      const x = Math.min(WIDTH - width / 2 - 8, Math.max(width / 2 + 8, desiredX));
      const y = Math.min(HEIGHT - height / 2 - 8, Math.max(height / 2 + 8, desiredY));
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

function adaptivePillText(parent: VectorNode, label: string, scale: number) {
  const text = textAt(parent, 0, 0, label, 'middle', 'pill-text');
  fitLabel(text, label, PILL_LINE_WIDTH);
  const { advance, bounds } = text.glyphs();
  text.setAttribute('y', -(bounds.top + bounds.bottom) / 2);
  const pad = MIN_TEXT_GAP_PX / scale;
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
