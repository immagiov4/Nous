import { diagram, formatOperand, pill, ruleOutsideSpan, textAt } from './chart';
import { type StudioViewport, studioAnchors, studioStage } from './chartDimensions';
import { heapTrace, type HeapSpec as Spec } from './heap';
import { heapCopy as copy, heapTitle } from './heap.copy.it';
import { MIN_TEXT_GAP_PX, MIN_TEXT_PX } from './layoutValidation';
import { appear, DIM, EXIT, FOCUS, MOVE, timeline } from './motion';
import { HEAP_LAYOUT, heapBars, treePoint } from './sortGeometry';
import { type StudioTimeline, setProperties } from './timeline';
import { heapEventTimes } from './traceTiming';
import { vectorBounds } from './vectorBounds';
import { type Point, svg, type VectorNode } from './vectorScene';

const arcHeight = 38;

function heapLayout(viewport?: StudioViewport) {
  const { x, y } = studioAnchors(viewport);
  const stage = studioStage(viewport);
  const referenceBottom = y(HEAP_LAYOUT.treeBottom);
  const radius = Math.min(HEAP_LAYOUT.radius, (stage.bottom - referenceBottom) / 2);
  const treeBottom = viewport
    ? Math.min(referenceBottom + MIN_TEXT_GAP_PX, stage.bottom - radius - 1)
    : referenceBottom;
  const lift = viewport ? MIN_TEXT_GAP_PX / 2 : 0;
  return {
    left: x(HEAP_LAYOUT.left),
    right: x(HEAP_LAYOUT.right),
    barTop: y(HEAP_LAYOUT.barTop) - lift,
    barBottom: y(HEAP_LAYOUT.barBottom) - lift,
    indexY: y(HEAP_LAYOUT.indexY),
    treeTop: y(HEAP_LAYOUT.treeTop),
    treeBottom,
    radius,
  };
}

function drawSlotNumbers(parent: VectorNode, positions: readonly Point[]) {
  if (parent.viewport) return [];
  return positions.map(([x, y], index) =>
    textAt(parent, x, y, String(index), 'middle', 'heap-index')
  );
}

function drawArray(
  parent: VectorNode,
  input: number[],
  x: (index: number) => number,
  slot: number,
  layout: typeof HEAP_LAYOUT
) {
  const { baseline, barWidth, heights } = heapBars(input, slot, layout);
  const labelOffset = parent.viewport ? MIN_TEXT_PX + MIN_TEXT_GAP_PX : 47;
  const valueY = layout.barBottom + labelOffset;
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
    textAt(group, 0, valueY, formatOperand(value), 'middle', 'heap-value');
    return group;
  });
  return { bars, barWidth, axis, valueY };
}

function drawTree(parent: VectorNode, input: number[], layout: typeof HEAP_LAYOUT) {
  const adaptive = parent.viewport !== undefined;
  const gap = adaptive ? MIN_TEXT_GAP_PX : 11;
  const labelRoom = adaptive ? MIN_TEXT_PX + gap : 0;
  const barTravel = adaptive ? 2 * labelRoom + gap : 64;
  const bottomOfMovingLabels = layout.barBottom + labelRoom + barTravel;
  // Reserve space for every level after allowing for moving labels.
  const levels = Math.max(2, Math.floor(Math.log2(input.length)));
  const latestTreeTop = layout.treeBottom - levels * layout.radius * (adaptive ? 2 : 1);
  const treeTop = adaptive
    ? Math.min(latestTreeTop, Math.max(layout.treeTop, bottomOfMovingLabels + gap + layout.radius))
    : layout.treeTop;
  const points = input.map((_, index) => treePoint(index, input.length, treeTop, layout));
  const edges = points.slice(1).map(([x2, y2], i) => {
    const [x1, y1] = points[Math.floor(i / 2)];
    const distance = Math.hypot(x2 - x1, y2 - y1);
    const scale = Math.min(0.5, (layout.radius + gap) / distance);
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
    textAt(group, 0, 7, formatOperand(value), 'middle', 'heap-value');
    return group;
  });
  const positions: Point[] = points.map(([x, y], index) => [
    x + (index % 2 ? -44 : 44),
    y + (index === 0 ? -4 : 5),
  ]);
  return {
    points,
    edges,
    nodes,
    indices: drawSlotNumbers(parent, positions),
  };
}

function moveBar(
  play: StudioTimeline,
  bar: VectorNode,
  {
    slot,
    previousSlot,
    slotX,
    blockingTop,
    duration,
    time,
  }: {
    slot: number;
    previousSlot: number;
    slotX: (index: number) => number;
    blockingTop: number;
    duration: number;
    time: number;
  }
) {
  const passesAnotherBar = Math.abs(previousSlot - slot) > 1;
  const labelRoom = bar.viewport ? MIN_TEXT_PX + MIN_TEXT_GAP_PX : arcHeight;
  const nearArc = bar.viewport ? labelRoom : arcHeight;
  const movesRight = previousSlot < slot;
  const releaseArc = movesRight ? 80 : 64;
  const farArc = bar.viewport ? 2 * labelRoom : releaseArc;
  const distance = passesAnotherBar ? Math.max(nearArc, farArc) : nearArc;
  const [rect, label] = bar.children;
  const top = rect.number('y'),
    height = rect.number('height');
  const compressed = Math.min(height, 6);
  const stagedCrossing = bar.viewport !== undefined;
  let arc = movesRight ? -distance : distance;
  if (stagedCrossing && movesRight && passesAnotherBar) {
    const clearance = Math.ceil(
      vectorBounds(label, false)[0].bottom - blockingTop + MIN_TEXT_GAP_PX
    );
    const stroke = top - vectorBounds(rect, false)[0].top;
    const availableLift = top + height - compressed - stroke - studioStage(bar.viewport).top;
    arc = -Math.min(Math.max(distance, clearance), availableLift);
  }
  const startX = slotX(previousSlot);
  const endX = slotX(slot);
  const x = stagedCrossing ? [startX, startX, endX, endX] : undefined;
  if (!x) play.to(bar, { ...MOVE, duration, x: endX }, time);
  // Lift before crossing other slots and lower after arrival.
  play.to(bar, { duration, keyframes: { x, y: [0, arc, arc, 0], ease: MOVE.ease } }, time);
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

export function buildHeap(
  { input, operation, beats }: Spec,
  root: VectorNode,
  beatTimesMs: number[]
) {
  const canvas = diagram(root, heapTitle(operation));
  const layout = heapLayout(root.viewport);
  const { x: atX, y: atY } = studioAnchors(root.viewport);
  const steps = heapTrace(input, operation);
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
  const frameTop = layout.barTop - 9,
    frameBottom = layout.indexY + 15;
  const sorted = svg(arrayGroup, 'rect', {
    class: 'heap-suffix',
    y: frameTop,
    height: frameBottom - frameTop,
    rx: 13,
    width: 0,
    opacity: 0,
  });
  const { bars, barWidth, axis, valueY } = drawArray(arrayGroup, input, x, slot, layout);
  sorted.setAttribute('x', x(input.length - 1) + barWidth / 2 + 9);
  const { nodes, points, edges, indices } = drawTree(treeGroup, input, layout);
  const tail = textAt(
    arrayGroup,
    x(input.length - 1),
    frameTop - 12,
    copy.settled,
    'middle',
    'heap-legend'
  );
  const dock = textAt(canvas, atX(46), atY(282), copy.tree, 'start', 'heap-legend');
  const arrayLegend = textAt(arrayGroup, atX(62), atY(28), copy.array, 'start', 'heap-legend');
  setProperties(tail, { opacity: 0 });
  if (root.viewport) {
    for (const label of [tail, dock, arrayLegend]) label.setAttribute('display', 'none');
  }
  drawSlotNumbers(
    arrayGroup,
    input.map((_, index) => [x(index), layout.indexY])
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
    let blockingTop = Infinity;
    if (changed.length) {
      const first = changed[0];
      const last = changed[changed.length - 1];
      const left = x(first) - slot / 2,
        right = x(last) + slot / 2;
      blockingTop = Math.min(
        ...previous.order
          .slice(first + 1, last)
          .map(id => vectorBounds(bars[id].children[0], false)[0].top)
      );
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
        moveBar(play, bars[value], {
          slot,
          previousSlot,
          slotX: x,
          blockingTop,
          duration,
          time,
        });
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
    if (step.event === 'done')
      play.to(arrayGroup, { ...MOVE, duration, y: atY(95) - atY(0) }, time);
  });

  for (const { event } of beats) {
    const stepIndex = steps.findIndex(step => step.event === event);
    const step = steps[stepIndex];
    const extracted = steps.slice(0, stepIndex).some(step => step.event.startsWith('extract#'));
    const generated = heapLabel(event, extracted);
    if (step.extracted !== undefined) {
      const callout = pill(bars[step.extracted], generated, 'callout');
      callout.group.data.secondaryLabel = 'true';
      callout.place([0, valueY], [0, valueY - 23]);
      appear(play, callout.group, times[stepIndex], times[stepIndex + 1]);
      continue;
    }
    const selected = step.focus.at(-1) ?? step.order[0];
    const position = step.order.indexOf(selected);
    const point =
      event === 'done' || position >= step.size
        ? ([x(position), layout.barBottom + 24 + (event === 'done' ? 95 : 0)] as Point)
        : points[position];
    const callout = pill(overlays, generated, 'callout');
    callout.group.data.secondaryLabel = 'true';
    const above = point[1] >= layout.treeTop + 30;
    callout.place(point, [point[0] + (point[0] > 700 ? -125 : 125), point[1] + (above ? -23 : 21)]);
    appear(play, callout.group, times[stepIndex], times[stepIndex + 1]);
  }
  return play;
}
