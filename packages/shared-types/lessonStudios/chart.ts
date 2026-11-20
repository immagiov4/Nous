import { rememberCallout } from './callouts';
import { chartViewport, HEIGHT, WIDTH } from './chartDimensions';
import { type StudioAnchor, type StudioTextStyle, studioTypeStyles } from './studioTypography';
import { type Point, svg, type VectorNode } from './vectorScene';

const number = new Intl.NumberFormat('it-IT', { maximumSignificantDigits: 4 });
export const format = (n: number) => number.format(Object.is(n, -0) ? 0 : n);
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
  text.label = { style: className, anchor, size: studioTypeStyles[className][0] };
  text.textContent = label;
  return text;
}

const MIN_LABEL_SIZE = 14;
const MAX_PILL_ROWS = 2;
const graphemes = new Intl.Segmenter('it', { granularity: 'grapheme' });

function fitText(node: VectorNode, value: string, width: number) {
  node.textContent = value;
  if (!node.label) throw new Error('Text needs a label style');
  node.removeAttribute('aria-label');
  const length = node.glyphs().advance;
  if (length <= width) return;
  const size = node.label.size;
  node.label.size = Math.max(Math.min(size, MIN_LABEL_SIZE), Math.floor((size * width) / length));
  if (node.glyphs().advance <= width) return;

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
}

export function diagram(root: VectorNode, label: string) {
  return svg(root, 'svg', {
    viewBox: `0 ${chartViewport.top} ${WIDTH} ${chartViewport.height}`,
    class: 'chart',
    role: 'img',
    'aria-label': label,
  });
}

/** Measure wrapped text once. Position the pill separately from its leader so both can follow a data point. */
export function pill(parent: VectorNode, label: string, className = '') {
  const group = svg(parent, 'g', { class: `pill ${className}` });
  const leader = svg(group, 'polyline', { class: 'leader', fill: 'none' });
  const body = svg(group, 'g', {});
  const rect = svg(body, 'rect', { rx: 16 });
  const text = svg(body, 'g', {});
  const maxLine = 258;
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
  rect.setAttribute('width', String(width));
  rect.setAttribute('height', String(height));
  rect.setAttribute('x', String(-width / 2));
  rect.setAttribute('y', String(-height / 2));
  rows[0].setAttribute('y', String(5 - ((rows.length - 1) * leading) / 2));
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
