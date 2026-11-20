import { diagram, format, type Point, pill, ruleOutsideSpan, textAt } from './chart';
import { heapTrace, type HeapSpec as Spec } from './heap';
import { copy } from './heap.copy.it';
import { appear, DIM, EXIT, FOCUS, MOVE, timeline } from './motion';
import { heapBars, HEAP_LAYOUT as layout, treePoint } from './sortGeometry';
import { type StudioTimeline, setProperties } from './timeline';
import { heapEventTimes } from './traceTiming';
import { svg, type VectorNode } from './vectorScene';

const arcHeight = 38;

function drawArray(
  parent: VectorNode,
  input: number[],
  x: (index: number) => number,
  slot: number
) {
  const { baseline, barWidth, heights } = heapBars(input, slot);
  const axis = svg(parent, 'line', {
    class: 'axis',
    x1: layout.left,
    x2: layout.right,
    y1: baseline,
    y2: baseline,
  });
  const bars = input.map((value, index) => {
    const group = svg(parent, 'g', {
      class: 'array-tile heap-tile',
      'data-value': value,
      'data-focus': 'false',
      'data-confirmed': 'false',
    });
    setProperties(group, { x: x(index) });
    svg(group, 'rect', {
      class: 'array-bar',
      rx: 8,
      x: -barWidth / 2,
      width: barWidth,
      ...heights[index],
    });
    textAt(group, 0, layout.barBottom + 47, format(value), 'middle', 'heap-value');
    return group;
  });
  return { bars, barWidth, axis };
}

function drawTree(parent: VectorNode, input: number[]) {
  const points = input.map((_, index) => treePoint(index, input.length));
  const edges = points.slice(1).map(([x2, y2], i) => {
    const [x1, y1] = points[Math.floor(i / 2)];
    const scale = (layout.radius + 11) / Math.hypot(x2 - x1, y2 - y1);
    const dx = (x2 - x1) * scale,
      dy = (y2 - y1) * scale;
    return svg(parent, 'line', {
      x1: x1 + dx,
      y1: y1 + dy,
      x2: x2 - dx,
      y2: y2 - dy,
      class: 'heap-link',
      'data-slot': i + 1,
    });
  });
  const nodes = input.map((value, index) => {
    const group = svg(parent, 'g', { class: 'heap-node', 'data-value': value });
    setProperties(group, { x: points[index][0], y: points[index][1] });
    svg(group, 'circle', { r: layout.radius });
    textAt(group, 0, 7, format(value), 'middle', 'heap-value');
    return group;
  });
  points.forEach(([x, y], index) =>
    textAt(
      parent,
      x + (index % 2 ? -44 : 44),
      y + (index === 0 ? -4 : 5),
      String(index),
      'middle',
      'heap-index'
    )
  );
  return {
    points,
    edges,
    nodes,
    indices: parent.children.filter(node => node.hasClass('heap-index')),
  };
}

function moveBar(
  play: StudioTimeline,
  bar: VectorNode,
  {
    slot,
    previousSlot,
    slotX,
    duration,
    time,
  }: {
    slot: number;
    previousSlot: number;
    slotX: number;
    duration: number;
    time: number;
  }
) {
  const passesAnotherBar = Math.abs(previousSlot - slot) > 1;
  let arc = passesAnotherBar ? 64 : arcHeight;
  if (previousSlot < slot) arc = -(passesAnotherBar ? 80 : arcHeight);
  play.to(bar, { ...MOVE, duration, x: slotX }, time);
  play.to(bar, { duration, keyframes: { y: [0, arc, arc, 0], ease: MOVE.ease } }, time);
  const rect = bar.children[0];
  const top = Number(rect.getAttribute('y')),
    height = Number(rect.getAttribute('height'));
  const compressed = Math.min(height, 6);
  play.to(
    rect,
    {
      duration,
      keyframes: [
        {
          attr: { y: top + height - compressed, height: compressed },
          duration: duration / 3,
          ease: FOCUS.ease,
        },
        {
          attr: { y: top + height - compressed, height: compressed },
          duration: duration / 3,
          ease: 'none',
        },
        { attr: { y: top, height }, duration: duration / 3, ease: MOVE.ease },
      ],
    },
    time
  );
}

function heapLabel(event: string, extracted: boolean) {
  if (event.startsWith('sift#')) return extracted ? copy.restore : copy.sift;
  if (event.startsWith('extract#')) return copy.extract;
  if (event === 'start') return copy.start;
  if (event === 'heapified') return copy.heapified;
  return copy.done;
}

export function buildHeap({ input, beats }: Spec, root: VectorNode, beatTimesMs: number[]) {
  const canvas = diagram(root, copy.title);
  const steps = heapTrace(input);
  const end = Number(root.data.durationMs) / 1000;
  const times = heapEventTimes(
    steps,
    beats.map(beat => beat.event),
    beatTimesMs,
    end
  );
  const play = timeline();
  const arrayGroup = svg(canvas, 'g', { class: 'heap-array' });
  const treeGroup = svg(canvas, 'g', { class: 'heap-tree' });
  const overlays = svg(canvas, 'g', {});
  const slot = (layout.right - layout.left) / input.length;
  const x = (index: number) => layout.left + (index + 0.5) * slot;
  const { bars, barWidth, axis } = drawArray(arrayGroup, input, x, slot);
  const { nodes, points, edges, indices } = drawTree(treeGroup, input);
  const frameTop = layout.barTop - 9,
    frameBottom = layout.indexY + 15;
  const sorted = svg(arrayGroup, 'rect', {
    class: 'heap-suffix',
    y: frameTop,
    height: frameBottom - frameTop,
    rx: 13,
    x: x(input.length - 1) + barWidth / 2 + 9,
    width: 0,
    opacity: 0,
  });
  arrayGroup.prepend(sorted);
  const tail = textAt(
    arrayGroup,
    x(input.length - 1),
    frameTop - 12,
    copy.settled,
    'middle',
    'heap-legend'
  );
  const dock = textAt(canvas, 46, 282, copy.tree, 'start', 'heap-legend');
  textAt(arrayGroup, 62, 28, copy.array, 'start', 'heap-legend');
  setProperties(tail, { opacity: 0 });
  input.forEach((_, i) =>
    textAt(arrayGroup, x(i), layout.indexY, String(i), 'middle', 'heap-index')
  );

  steps.forEach((step, i) => {
    if (i === 0) return;
    const time = times[i];
    const previous = steps[i - 1];
    const remaining = (times[i + 1] ?? end) - time;
    const duration = Math.min(MOVE.duration, remaining);
    const focus = { ...FOCUS, duration: Math.min(FOCUS.duration, remaining) };
    const changed = step.order.flatMap((value, slot) =>
      previous.order[slot] !== value ? [slot] : []
    );
    if (changed.length) {
      const left = x(changed[0]) - slot / 2,
        right = x(changed.at(-1)!) + slot / 2;
      play.set(
        axis,
        { attr: { 'stroke-dasharray': ruleOutsideSpan(layout.left, layout.right, left, right) } },
        time
      );
      play.set(axis, { attr: { 'stroke-dasharray': 'none' } }, time + duration);
    }
    step.order.forEach((value, slot) => {
      const active = step.focus.includes(value);
      const previousSlot = previous.order.indexOf(value);
      const settled = slot >= step.size;
      const enteringTail = value === step.extracted;
      const larger = String(value === step.largerChild);
      play.set(
        bars[value],
        {
          attr: {
            'data-focus': String(active),
            'data-confirmed': String(settled),
            'data-larger': larger,
          },
        },
        time
      );
      play.to(bars[value], { ...focus, opacity: active ? 1 : DIM }, time);
      if (previousSlot !== slot)
        moveBar(play, bars[value], { slot, previousSlot, slotX: x(slot), duration, time });
      if (previousSlot >= previous.size) return;
      const [treeX, treeY] = enteringTail ? points[previousSlot] : points[slot];
      play.set(
        nodes[value],
        { attr: { 'data-active': String(active), 'data-larger': larger } },
        time
      );
      const node = nodes[value];
      const settle = step.extracted !== undefined ? Math.min(EXIT.duration, duration / 3) : 0;
      const opacity = active ? 1 : DIM;
      play.to(
        node,
        {
          ...FOCUS,
          duration: enteringTail ? settle : duration,
          opacity: enteringTail ? 0 : opacity,
        },
        time
      );
      if (!enteringTail && previousSlot !== slot) {
        const [fromX, fromY] = points[previousSlot];
        const dx = treeX - fromX,
          dy = treeY - fromY;
        const turn = (layout.radius + 17) / Math.hypot(dx, dy);
        play.to(
          node,
          {
            duration: duration - settle,
            keyframes: {
              x: [fromX, (fromX + treeX) / 2 + dy * turn, treeX],
              y: [fromY, (fromY + treeY) / 2 - dx * turn, treeY],
              ease: MOVE.ease,
            },
          },
          time + settle
        );
      }
    });
    edges.forEach((element, index) => {
      const child = index + 1;
      const parent = Math.floor(index / 2);
      const active =
        step.focus.includes(step.order[child]) && step.focus.includes(step.order[parent]);
      const emphasis = active ? 1 : DIM;
      play.to(element, { ...focus, opacity: child >= step.size ? 0 : emphasis }, time);
    });
    indices.forEach((element, position) =>
      play.to(element, { ...focus, opacity: position < step.size ? 1 : 0 }, time)
    );
    if (step.extracted !== undefined) {
      const left = x(step.size) - barWidth / 2 - 9;
      const right = x(input.length - 1) + barWidth / 2 + 9;
      play.set(sorted, { attr: { x: left, width: right - left, opacity: 1 } }, time + duration);
      play.set(tail, { opacity: 1, attr: { x: (left + right) / 2 } }, time + duration);
    }
    if (step.event === 'heapified') play.set(dock, { textContent: copy.heap }, time);
    if (!step.size) play.to(dock, { ...focus, opacity: 0 }, time);
    if (step.event === 'done') play.to(arrayGroup, { ...MOVE, duration, y: 95 }, time);
  });

  beats.forEach(({ event }) => {
    const stepIndex = steps.findIndex(step => step.event === event);
    const step = steps[stepIndex];
    const extracted = steps.slice(0, stepIndex).some(step => step.event.startsWith('extract#'));
    const generated = heapLabel(event, extracted);
    const selected = step.focus.at(-1) ?? step.order[0];
    const position = step.order.indexOf(selected);
    const point =
      event === 'done' || position >= step.size
        ? ([x(position), layout.barBottom + 24 + (event === 'done' ? 95 : 0)] as Point)
        : points[position];
    const callout = pill(overlays, generated, 'callout');
    const above = point[1] >= layout.treeTop + 30;
    callout.place(point, [point[0] + (point[0] > 700 ? -125 : 125), point[1] + (above ? -23 : 21)]);
    appear(play, callout.group, times[stepIndex], times[stepIndex + 1]);
  });
  return play;
}
