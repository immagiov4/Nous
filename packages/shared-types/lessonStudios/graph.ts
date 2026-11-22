import { nearestClearBox } from './callouts';
import { diagram, fitLabel, pill, textAt } from './chart';
import { studioAnchors, studioStage } from './chartDimensions';
import { graphCopy as copy, fixed, initial, relax, shortestPath } from './graph.copy.it';
import { graphLayout, layeredNodeHeight } from './graphLayout';
import { computeGraphTrace, graphHierarchy, type GraphSpec as Spec } from './graphSpec';
import { traceTimes } from './graphTiming';
import { graphDescendants, type shortestPaths } from './graphTrace';
import { MIN_TEXT_GAP_PX, MIN_TEXT_PX } from './layoutValidation';
import { appear, DIM, EXIT, FOCUS, MOVE, STAGGER, timeline } from './motion';
import { motionEase, type StudioTimeline, setProperties } from './timeline';
import { type Box, boxDistance, enclosingBoxes, vectorBounds } from './vectorBounds';
import { type Point, svg, type VectorNode } from './vectorScene';

export { checkGraphSpec, GraphSpecSchema } from './graphSpec';

type CostFormatter = (value: number) => string;
type DistanceChange = {
  at: number;
  duration: number;
  previous: number;
  value: number;
};
type Step = ReturnType<typeof shortestPaths>[number];

function distanceAt(change: DistanceChange, seconds: number, reduced?: boolean) {
  const { at, previous, value, duration } = change;
  const progress =
    duration === 0 || reduced ? 1 : motionEase(MOVE.ease)(Math.min(1, (seconds - at) / duration));
  if (Number.isFinite(previous) && Number.isFinite(value))
    return previous + (value - previous) * progress;
  return progress > 0 ? value : previous;
}

function renderDistances(
  tracks: Map<VectorNode, DistanceChange[]>,
  format: CostFormatter,
  seconds: number,
  reduced?: boolean
) {
  for (const [text, changes] of tracks) {
    let index = changes.length - 1;
    while (index >= 0 && changes[index].at > seconds) index--;
    const change = changes[index];
    if (!change) {
      const initial = changes[0].previous;
      text.textContent = Number.isFinite(initial) ? format(initial) : copy.infinity;
      continue;
    }
    const distance = distanceAt(change, seconds, reduced);
    text.textContent = Number.isFinite(distance) ? format(distance) : copy.infinity;
  }
}

const groups = ['var(--chart-1)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-2)'];
type NodeView = {
  base: Point;
  group: VectorNode;
  shape: VectorNode;
  distance: VectorNode | null;
  width: number;
  height: number;
};
type EdgeView = {
  group: VectorNode;
  line: VectorNode;
  pulse: VectorNode;
  badge?: { pill: ReturnType<typeof pill>; target: Point };
};

function fitNodeHeight(text: VectorNode, height: number) {
  const { top, bottom } = text.glyphs().bounds;
  const baseline = Math.max(-height / 2 - top, Math.min(height / 2 - bottom, text.number('y')));
  text.setAttribute('y', baseline);
  return bottom - top <= height;
}

function nodeView(
  layer: VectorNode,
  point: Point,
  label: string,
  key: string,
  color: string,
  width: number,
  weighted: boolean,
  height = 50,
  labelWidth = width
): NodeView {
  const group = svg(layer, 'g', {
    class: 'graph-node',
    'data-node': key,
    'data-studio-target': key,
  });
  group.setAttribute('style', '--group:' + color);
  setProperties(group, { x: point[0], y: point[1] });
  const shape = svg(group, 'rect', { x: -width / 2, y: -height / 2, width, height, rx: 13 });
  if (weighted)
    svg(group, 'circle', {
      class: 'graph-settled-ring',
      cx: -width / 2 + 16,
      r: 6,
      'aria-hidden': 'true',
    });
  const name = textAt(group, weighted ? -16 : 0, 7, label, 'middle', 'graph-name');
  const nodeLabelInset = group.viewport ? MIN_TEXT_GAP_PX : 28;
  const textWidth = labelWidth - (weighted ? 54 : nodeLabelInset);
  const nameFits = fitLabel(name, label, textWidth, height < 45 ? 1 : 2);
  const distance = weighted
    ? textAt(group, 30, 7, copy.infinity, 'middle', 'graph-distance')
    : null;
  if (group.viewport && layer.parent) {
    const labels = distance ? [name, distance] : [name];
    const heightFits = labels.map(text => fitNodeHeight(text, height)).every(Boolean);
    if (!nameFits || !heightFits) layer.parent.data.unplacedRequiredLabel = 'true';
  }
  return { base: point, group, shape, distance, width, height };
}

function endpoint(
  [ax, ay]: Point,
  [bx, by]: Point,
  width: number,
  height: number,
  gap: number
): Point {
  const dx = bx - ax,
    dy = by - ay;
  const ratio = Math.min((width / 2 + gap) / Math.abs(dx), (height / 2 + gap) / Math.abs(dy));
  return [ax + dx * ratio, ay + dy * ratio];
}

const arrowViewBox = 8;
const arrowReference = 5;
const arrowSize = 10;
const GRAPH_NODE_HEIGHT = 50;

function relationMoveDuration(event: Spec['beats'][number]['event'], span: number) {
  // Reserve part of short comparisons for the verdict once the nodes have moved.
  return Math.min(MOVE.duration, event === 'compare' ? span / 2 : span);
}

function edgeEndpoints(from: NodeView, to: NodeView, directed: boolean): [Point, Point] {
  const start = endpoint(from.base, to.base, from.width, from.height, 9);
  const end = endpoint(to.base, from.base, to.width, to.height, directed ? 14 : 9);
  const dx = to.base[0] - from.base[0];
  const dy = to.base[1] - from.base[1];
  const length = Math.hypot(dx, dy);
  const along = (a: Point, b: Point) => ((b[0] - a[0]) * dx + (b[1] - a[1]) * dy) / length;
  const shaft = directed ? arrowSize : 0;
  if (along(start, end) > shaft) return [start, end];

  // In a narrow rank gap, reduce the padding before it consumes the arrow shaft.
  const fromBorder = endpoint(from.base, to.base, from.width, from.height, 0);
  const toBorder = endpoint(to.base, from.base, to.width, to.height, 0);
  const space = along(fromBorder, toBorder);
  const tip = directed ? (arrowSize * (arrowViewBox - arrowReference)) / arrowViewBox : 0;
  const targetPadding = Math.min(directed ? tip + 1 : 0, Math.max(0, space * 0.75));
  const sourcePadding = Math.max(1, (space - targetPadding - shaft) / 2);
  return [
    [fromBorder[0] + (dx * sourcePadding) / length, fromBorder[1] + (dy * sourcePadding) / length],
    [toBorder[0] - (dx * targetPadding) / length, toBorder[1] - (dy * targetPadding) / length],
  ];
}

function edgeView(
  layer: VectorNode,
  from: NodeView,
  to: NodeView,
  label: string,
  directed: boolean,
  marker: string,
  curve: number
): EdgeView {
  const [[x, y], [tx, ty]] = edgeEndpoints(from, to, directed);
  const controlX = (x + tx) / 2 + (ty - y) * curve;
  const controlY = (y + ty) / 2 - (tx - x) * curve;
  const d = curve ? `M${x},${y} Q${controlX},${controlY} ${tx},${ty}` : `M${x},${y} L${tx},${ty}`;
  const group = svg(layer, 'g', { class: 'graph-edge' });
  const line = svg(group, 'path', { d, class: 'graph-line' });
  if (directed) line.setAttribute('marker-end', 'url(#' + marker + ')');
  const pulse = svg(group, 'path', {
    d,
    pathLength: 1,
    'stroke-dasharray': 1,
    'stroke-dashoffset': 1,
    class: 'graph-pulse',
    opacity: 0,
  });
  if (label) {
    const badge = pill(group, label, 'graph-edge-label');
    const point: Point = [(controlX + (x + tx) / 2) / 2, (controlY + (y + ty) / 2) / 2];
    badge.place(point, point);
    return { group, line, pulse, badge: { pill: badge, target: point } };
  }
  return { group, line, pulse };
}

function placeEdgeBadges(canvas: VectorNode, nodes: VectorNode, edges: EdgeView[]) {
  if (!canvas.viewport) return;
  const stage = studioStage(canvas.viewport);
  const clear = MIN_TEXT_GAP_PX;
  const area = {
    left: clear,
    top: clear,
    right: stage.width - clear,
    bottom: stage.bottom - clear,
  };
  const pad = ({ left, top, right, bottom }: Box): Box => ({
    left: left - clear,
    top: top - clear,
    right: right + clear,
    bottom: bottom + clear,
  });
  const occupied = enclosingBoxes(nodes).flatMap(({ boxes }) => boxes.map(pad));
  const corridors = edges.map(({ line }) => vectorBounds(line).map(pad));
  for (const [index, edge] of edges.entries()) {
    if (!edge.badge) continue;
    const {
      pill: badge,
      target: [x, y],
    } = edge.badge;
    const preferred = {
      left: x - badge.width / 2,
      top: y - badge.height / 2,
      right: x + badge.width / 2,
      bottom: y + badge.height / 2,
    };
    const obstacles = occupied.concat(...corridors.filter((_, other) => index !== other));
    const chosen = nearestClearBox(preferred, area, obstacles);
    if (!chosen) {
      canvas.data.unplacedRequiredLabel = 'true';
      continue;
    }
    if (chosen !== preferred) {
      badge.group.setAttribute('data-offset-edge-label', '');
      badge.place([x, y], [(chosen.left + chosen.right) / 2, (chosen.top + chosen.bottom) / 2]);
    }
    occupied.push(pad(chosen));
  }
}

function fitGraphReadouts(
  canvas: VectorNode,
  hud: VectorNode,
  result: VectorNode,
  baseline: number
) {
  if (!hud.viewport) return;
  const available = result.number('x') - hud.number('x');
  const hudFits = fitLabel(hud, hud.textContent, available, 1);
  const resultFits = fitLabel(result, result.textContent, available, 1);
  hud.setAttribute('y', baseline);
  result.setAttribute('y', baseline);
  const [queueBox] = vectorBounds(hud);
  const [orderBox] = vectorBounds(result);
  if (queueBox && orderBox && boxDistance(queueBox, orderBox) < MIN_TEXT_GAP_PX) {
    hud.setAttribute('y', baseline - Math.max(0, queueBox.bottom - orderBox.top + MIN_TEXT_GAP_PX));
  }
  if (hudFits && resultFits) delete canvas.data.unplacedRequiredLabel;
  else canvas.data.unplacedRequiredLabel = 'true';
}

function graphNodeState(step: Step, id: string) {
  if (step.focus.includes(id)) return 'active';
  if (step.settled.includes(id)) return 'settled';
  return step.frontier.includes(id) ? 'frontier' : 'idle';
}

function algorithmCueLabel(
  mode: NonNullable<Spec['algorithm']>['kind'],
  step: Step,
  names: Map<string, string>,
  format: CostFormatter
) {
  const [from, to] = step.focus;
  const node = names.get(from) ?? copy.empty;
  if (mode !== 'dijkstra') return step.event === 'done' ? copy.order : node;
  if (step.event === 'start') return initial(node);
  if (step.event === 'done') return undefined;
  if (step.event.startsWith('relax:'))
    return relax(node, names.get(to)!, format(step.distances![to]));
  return step.settled.length === 1 ? fixed(node) : copy.next;
}

function animateAlgorithm(
  spec: Spec,
  root: VectorNode,
  play: StudioTimeline,
  views: Map<string, NodeView>,
  links: EdgeView[],
  hud: VectorNode,
  result: VectorNode,
  calls: VectorNode,
  times: number[],
  end: number,
  format: CostFormatter
) {
  const events = computeGraphTrace(spec);
  const at = traceTimes(
    root,
    events.map(step => step.event),
    spec.beats.map(beat => beat.event),
    times,
    end
  );
  const names = new Map(spec.nodes.map(({ id, label }) => [id, label]));
  const listed = (ids: string[]) =>
    ids.length ? ids.map(id => names.get(id)).join(copy.separator) : copy.empty;
  const mode = spec.algorithm!.kind;
  const distanceTracks = new Map<VectorNode, DistanceChange[]>();
  if (mode === 'dijkstra') {
    views.get(spec.algorithm!.start!)!.distance!.textContent = format(0);
  }
  hud.textContent = copy.hud[mode] + '   ' + listed(events[0].frontier);
  result.textContent = (mode === 'dijkstra' ? copy.settled : copy.order) + '   ' + copy.empty;
  type StepTiming = { t: number; duration: number; focus: number };
  function animateNodes(step: Step, i: number, { t, duration, focus }: StepTiming) {
    for (const [id, view] of views) {
      const state = graphNodeState(step, id);
      const settled = mode === 'dijkstra' && step.settled.includes(id);
      play.set(view.group, { attr: { 'data-state': state, 'data-settled': String(settled) } }, t);
      play.to(
        view.group,
        { ...FOCUS, duration: focus, opacity: state === 'active' || settled ? 1 : DIM },
        t
      );
      if (!view.distance || !step.distances) continue;
      const value = step.distances[id],
        prev = events[i - 1]?.distances?.[id] ?? Infinity;
      if (i === 0 || value === prev) continue;
      const text = view.distance;
      const changes = distanceTracks.get(text) ?? [];
      changes.push({ at: t, duration, previous: prev, value });
      distanceTracks.set(text, changes);
    }
  }

  function animateEdges(step: Step, { t, duration, focus, next }: StepTiming & { next: number }) {
    links.forEach(({ group }, index) =>
      play.to(
        group,
        {
          ...FOCUS,
          duration: focus,
          opacity: step.edge?.index === index || step.path?.includes(index) ? 1 : DIM,
        },
        t
      )
    );
    if (step.edge !== undefined) {
      const { index, from } = step.edge;
      const { pulse } = links[index];
      const draw = Math.min(duration, (next - t) / 2);
      play.fromTo(
        pulse,
        {
          opacity: 1,
          attr: { 'stroke-dashoffset': from === spec.edges[index].from ? 1 : -1 },
        },
        { ...MOVE, duration: draw, attr: { 'stroke-dashoffset': 0 } },
        t
      );
      play.to(
        pulse,
        { ...EXIT, duration: Math.min(EXIT.duration, next - t - draw), opacity: 0 },
        t + draw
      );
    }
    if (step.path?.length) {
      const stagger = Math.min(STAGGER, duration / step.path.length);
      step.path.forEach((index, position) => {
        const { pulse } = links[index];
        play.fromTo(
          pulse,
          {
            opacity: 1,
            attr: { 'stroke-dashoffset': step.focus[position] === spec.edges[index].from ? 1 : -1 },
          },
          { ...MOVE, duration: duration - stagger * position, attr: { 'stroke-dashoffset': 0 } },
          t + stagger * position
        );
      });
    }
  }

  for (const [i, step] of events.entries()) {
    const t = at[i],
      next = at[i + 1] ?? end;
    const duration = Math.min(MOVE.duration, next - t);
    const focus = Math.min(FOCUS.duration, next - t);
    animateNodes(step, i, { t, duration, focus });
    animateEdges(step, { t, duration, focus, next });
    const distance = step.distances?.[spec.algorithm!.target!];
    const order = listed(step.settled);
    let summary = copy.order + '   ' + order;
    if (mode === 'dijkstra') {
      summary = copy.settled + '   ' + order;
      if (step.event === 'done')
        summary = Number.isFinite(distance) ? shortestPath(listed(step.focus)) : copy.unreachable;
    }
    play.set(hud, { textContent: copy.hud[mode] + '   ' + listed(step.frontier) }, t);
    play.set(result, { textContent: summary }, t);
  }
  spec.beats.forEach(({ event, label }) => {
    const index = events.findIndex(candidate => candidate.event === event);
    const step = events[index];
    const view = views.get(step.focus.at(-1) ?? spec.nodes[0].id)!;
    const message = label ?? algorithmCueLabel(mode, step, names, format);
    if (!message) return;
    const callout = pill(calls, message, 'callout');
    callout.place([view.base[0], view.base[1] - 25], [view.base[0], view.base[1] - 56]);
    appear(play, callout.group, at[index], at[index + 1]);
  });
  return (seconds: number, reduced?: boolean) =>
    renderDistances(distanceTracks, format, seconds, reduced);
}

const compactScale = 0.56;

const compactWidthForLabel = (width: number) => Math.min(width, 425, width * compactScale + 38);

function relationNodePosition(
  base: Point,
  comparison: Point | undefined,
  collapsed: Point | undefined,
  compactCenter: number | undefined,
  center: number
): Point {
  if (comparison) return comparison;
  if (collapsed) return collapsed;
  return compactCenter === undefined
    ? base
    : [compactCenter + (base[0] - center) * compactScale, base[1]];
}

function animateRelations(
  spec: Spec,
  play: StudioTimeline,
  views: Map<string, NodeView>,
  links: EdgeView[],
  calls: VectorNode,
  times: number[],
  end: number
) {
  const { x: atX, y: atY } = studioAnchors(calls.viewport);
  const compactX = (x: number) => atX(231) + (x - atX(500)) * compactScale;
  const verdictHeight = calls.viewport ? 2 * (MIN_TEXT_PX + MIN_TEXT_GAP_PX) : 59;
  const verdictBaseline = atY(282) + (calls.viewport ? MIN_TEXT_PX + MIN_TEXT_GAP_PX : 36);
  type RelationPose = {
    nodes: string[];
    example?: [string, string];
    collapse: Set<string>;
    focus: Set<string>;
    compared: boolean;
    t: number;
    duration: number;
  };

  function animateRelationNodes({
    nodes,
    winner,
    example,
    pair,
    collapse,
    focus,
    compared,
    t,
    duration,
  }: RelationPose & { winner?: string; pair: Point[] }) {
    const comparedNodes = compared && !example;
    const emphasizeAll = Boolean(example) || focus.size === 0;
    const collapsedPosition = views.get(nodes[0])?.base;
    views.forEach((view, id) => {
      const position = nodes.indexOf(id);
      const comparedNode = comparedNodes && position >= 0;
      const collapsed = collapse.has(id);
      const [x, y] = relationNodePosition(
        view.base,
        comparedNode ? pair[position] : undefined,
        collapsed ? collapsedPosition : undefined,
        example ? atX(231) : undefined,
        atX(500)
      );
      const naturalWidth = example ? compactWidthForLabel(view.width) : view.width;
      const width = comparedNode ? atX(330) : naturalWidth;
      play.to(view.group, { ...MOVE, duration, x, y }, t);
      const emphasis = emphasizeAll || focus.has(id) ? 1 : DIM;
      const nextOpacity = collapsed ? 0 : emphasis;
      play.to(
        view.group,
        { ...FOCUS, duration: Math.min(FOCUS.duration, duration), opacity: nextOpacity },
        t
      );
      play.to(view.shape, { ...MOVE, duration, attr: { x: -width / 2, width } }, t);
      const state = focus.has(id) ? 'active' : 'idle';
      play.set(view.group, { attr: { 'data-state': winner === id ? 'settled' : state } }, t);
    });
  }

  function animateRelationEdges({
    nodes,
    example,
    collapse,
    focus,
    compared,
    selectedPath,
    t,
    duration,
  }: RelationPose & { selectedPath: boolean }) {
    spec.edges.forEach(({ from, to, directed }, index) => {
      const { group, pulse } = links[index];
      const hidden =
        !!example ||
        (compared && (focus.has(from) || focus.has(to))) ||
        collapse.has(from) ||
        collapse.has(to);
      const lineFocused =
        !focus.size ||
        (selectedPath
          ? nodes.some(
              (id, n) =>
                (id === from && nodes[n + 1] === to) ||
                (!directed && id === to && nodes[n + 1] === from)
            )
          : focus.has(from) && focus.has(to));
      const emphasis = lineFocused ? 1 : DIM;
      const fade = Math.min(FOCUS.duration, duration);
      play.to(
        group,
        {
          ...FOCUS,
          // Old links clear the path of nodes moving into a comparison.
          duration: compared && hidden ? fade / 2 : fade,
          opacity: hidden ? 0 : emphasis,
        },
        t
      );
      const highlighted = selectedPath && lineFocused;
      play.to(
        pulse,
        {
          ...MOVE,
          duration,
          opacity: highlighted ? 1 : 0,
          attr: { 'stroke-dashoffset': highlighted ? 0 : 1 },
        },
        t
      );
    });
  }

  spec.beats.forEach(({ event, nodes = [], winner, reason, label, pair: example, prevails }, i) => {
    const t = times[i],
      next = times[i + 1] ?? end;
    const duration = relationMoveDuration(event, next - t);
    const collapse =
      event === 'collapse-subtree' ? graphDescendants(spec.edges, nodes[0]) : new Set<string>();
    const compared = event === 'compare';
    const pair: Point[] = example
      ? [
          [atX(595), atY(203)],
          [atX(852), atY(203)],
        ]
      : [
          [atX(276), atY(214)],
          [atX(724), atY(214)],
        ];
    const panelCenter = example ? (pair[0][0] + pair[1][0]) / 2 : atX(500);
    const focus = new Set(nodes);
    const selectedPath = event === 'highlight-path';
    animateRelationNodes({ nodes, winner, example, pair, collapse, focus, compared, t, duration });
    animateRelationEdges({ nodes, example, collapse, focus, compared, selectedPath, t, duration });
    if (compared) {
      if (example) {
        example.forEach((name, index) => {
          const level = views.get(nodes[index])!;
          const origin = level.base;
          const levelPoint: Point = [
            compactX(origin[0]) + compactWidthForLabel(level.width) / 2,
            origin[1],
          ];
          const [x, y] = pair[index];
          const elbowX = atX(454 + index * 15);
          const laneY = atY(136 - index * 26);
          const leader = svg(calls, 'path', {
            class: 'graph-norm-link',
            fill: 'none',
            stroke: groups[index],
            'stroke-width': 2,
            opacity: 0,
            d: `M${levelPoint.join(' ')} H${elbowX} V${laneY} H${x} V${y - 25}`,
          });
          const sample = nodeView(calls, [x, y], name, '', groups[index], atX(233), false);
          sample.group.setAttribute('data-state', index === prevails ? 'settled' : 'active');
          setProperties(sample.group, { opacity: 0 });
          play.to(
            [leader, sample.group],
            { ...FOCUS, duration: Math.min(FOCUS.duration, duration), opacity: 1 },
            t
          );
          if (times[i + 1] !== undefined) {
            const exit = Math.min(EXIT.duration, duration / 2);
            play.to([leader, sample.group], { ...EXIT, duration: exit, opacity: 0 }, next - exit);
          }
        });
      }
      const [x, y] = pair[prevails ?? nodes.indexOf(winner!)];
      const verdict = pill(calls, copy.prevails, 'success-pill');
      verdict.place([x, y - 25], [x, y - 52]);
      // The winner's original box can cross the verdict while moving into the comparison.
      const verdictStart = { normal: t + duration, reduced: t };
      appear(play, verdict.group, verdictStart, times[i + 1]);
      const explanation = svg(calls, 'g', { class: 'graph-verdict' });
      const width = atX(example ? 514 : 662);
      svg(explanation, 'rect', {
        x: panelCenter - width / 2,
        y: atY(282),
        width,
        height: verdictHeight,
        rx: 17,
      });
      const note = textAt(
        explanation,
        panelCenter,
        verdictBaseline,
        reason!,
        'middle',
        'graph-reason'
      );
      fitLabel(note, reason!, width - 24);
      appear(play, explanation, verdictStart, times[i + 1]);
      if (label) {
        const callout = pill(calls, label, 'callout');
        callout.place([panelCenter, atY(282)], [panelCenter, atY(251)]);
        appear(play, callout.group, t, times[i + 1]);
      }
    } else if (label && nodes.length) {
      const callout = pill(calls, label, 'callout');
      const view = views.get(nodes[0])!;
      const offset = view.width > 172 ? 48 : 55;
      callout.place([view.base[0], view.base[1] - 25], [view.base[0], view.base[1] - offset]);
      appear(play, callout.group, t, times[i + 1]);
    } else if (label) {
      const callout = pill(calls, label, 'callout');
      callout.place([atX(500), atY(88)], [atX(500), atY(40)]);
      appear(play, callout.group, t, times[i + 1]);
    }
  });
}

function graphCostFormatter(edges: Spec['edges']): CostFormatter {
  const precision = Math.min(
    12,
    Math.max(
      0,
      ...edges.map(edge => {
        const [decimal, exponent = '0'] = String(edge.weight ?? 1).split('e');
        return (decimal.split('.')[1]?.length ?? 0) - Number(exponent);
      })
    )
  );
  const decimal = new Intl.NumberFormat('it-IT', { maximumFractionDigits: precision });
  const scientific = new Intl.NumberFormat('it-IT', {
    notation: 'scientific',
    maximumSignificantDigits: 21,
  });
  const zero = decimal.format(0);
  return value => {
    if (String(value).includes('e+')) return scientific.format(value);
    const label = decimal.format(value);
    return value !== 0 && (label === zero || label === `-${zero}`)
      ? scientific.format(value)
      : label;
  };
}

function fitGraphReadoutSpace(points: Map<string, Point>, bottom: number) {
  const preferredY = [...points.values()].map(([, y]) => y);
  const preferredTop = Math.min(...preferredY);
  const preferredBottom = Math.max(...preferredY);
  const top = Math.max(preferredTop, GRAPH_NODE_HEIGHT / 2 + MIN_TEXT_GAP_PX);
  const end = Math.max(top, Math.min(bottom, preferredBottom));
  if (top === preferredTop && end === preferredBottom) return;
  const span = preferredBottom - preferredTop;
  for (const [id, [x, y]] of points) {
    points.set(id, [x, span ? top + ((y - preferredTop) * (end - top)) / span : (top + end) / 2]);
  }
}

export function buildGraph(spec: Spec, root: VectorNode, beatTimesMs: number[]) {
  const end = Number(root.data.durationMs) / 1000;
  const times = beatTimesMs.map(ms => ms / 1000);
  const play = timeline();
  const canvas = diagram(root, spec.title);
  const edgeLayer = svg(canvas, 'g', {});
  const nodeLayer = svg(canvas, 'g', {});
  const calls = svg(canvas, 'g', {});
  const mode = spec.algorithm?.kind;
  const structure = graphHierarchy(spec);
  canvas.data.layout = structure ?? spec.layout ?? 'layered';
  const { x: atX, y: atY } = studioAnchors(root.viewport);
  const stage = studioStage(root.viewport);
  const referencePoints = graphLayout(
    spec.nodes.map(node => node.id),
    spec.edges,
    structure ? 'tree' : (spec.layout ?? 'layered'),
    !!mode
  );
  const readoutBaseline = stage.bottom - MIN_TEXT_GAP_PX;
  const readoutBand = 2 * (MIN_TEXT_PX + MIN_TEXT_GAP_PX) + MIN_TEXT_GAP_PX;
  const graphBottom = readoutBaseline - readoutBand - GRAPH_NODE_HEIGHT / 2;
  const points = new Map(
    [...referencePoints].map(([id, [x, y]]): [string, Point] => [id, [atX(x), atY(y)]])
  );
  if (mode && root.viewport) fitGraphReadoutSpace(points, graphBottom);
  const ranks = [...new Set([...points.values()].map(([x]) => x))].sort((a, b) => a - b);
  const rankWidth =
    root.viewport && canvas.data.layout === 'layered' && ranks.length > 1
      ? Math.min(...ranks.slice(1).map((x, index) => x - ranks[index])) - MIN_TEXT_GAP_PX
      : Infinity;
  const pyramid = structure === 'pyramid';
  const palette = [...new Set(spec.nodes.map(node => node.group))];
  const levels = [...new Set([...points.values()].map(([, y]) => y))].sort((a, b) => a - b);
  const depth = levels[1] - levels[0] || 58;
  let height = GRAPH_NODE_HEIGHT;
  if (structure) height = Math.min(height, depth - 10);
  if (canvas.data.layout === 'layered') height = layeredNodeHeight(points, height, 10);
  const columns = Math.max(
    ...levels.map(y => [...points.values()].filter(([, row]) => row === y).length)
  );
  const hasExamples = spec.beats.some(beat => beat.pair);
  const nodes = new Map(
    spec.nodes.map(node => {
      const base = points.get(node.id)!;
      const level = levels.indexOf(base[1]);
      const preferredWidth = pyramid
        ? atX(275) + (level * atX(460)) / Math.max(1, levels.length - 1)
        : Math.min(158, atX(680) / columns);
      const width = root.viewport
        ? Math.min(
            preferredWidth,
            rankWidth,
            2 * (Math.min(base[0], stage.width - base[0]) - MIN_TEXT_GAP_PX)
          )
        : preferredWidth;
      const labelWidth = hasExamples ? compactWidthForLabel(width) : width;
      const hue = groups[palette.indexOf(node.group) % groups.length];
      return [
        node.id,
        nodeView(
          nodeLayer,
          base,
          node.label,
          node.id,
          hue,
          width,
          mode === 'dijkstra',
          height,
          labelWidth
        ),
      ];
    })
  );
  const markerId = 'graph-arrow';
  const marker = svg(svg(canvas, 'defs', {}), 'marker', {
    id: markerId,
    viewBox: `0 0 ${arrowViewBox} ${arrowViewBox}`,
    refX: arrowReference,
    refY: arrowViewBox / 2,
    markerUnits: 'userSpaceOnUse',
    markerWidth: arrowSize,
    markerHeight: arrowSize,
    orient: 'auto',
  });
  svg(marker, 'path', { d: 'M0 0L8 4L0 8Z', fill: 'var(--muted)' });
  const format = graphCostFormatter(spec.edges);
  const links = spec.edges.map((edge, index) => {
    const reverse = spec.edges.some(
      candidate => candidate.from === edge.to && candidate.to === edge.from
    );
    const label = edge.label ?? (edge.weight === undefined ? '' : format(edge.weight));
    const view = edgeView(
      edgeLayer,
      nodes.get(edge.from)!,
      nodes.get(edge.to)!,
      label,
      edge.directed ?? false,
      markerId,
      reverse ? 0.3 : 0
    );
    view.group.setAttribute('data-studio-target', `edge:${index}`);
    return view;
  });
  placeEdgeBadges(canvas, nodeLayer, links);
  let drawDistances: ((seconds: number, reduced?: boolean) => void) | undefined;
  let fitReadouts: (() => void) | undefined;
  if (mode) {
    if (!root.viewport)
      svg(canvas, 'line', { class: 'hud-rule', x1: 80, x2: 920, y1: 393, y2: 393 });
    const baseline = root.viewport ? readoutBaseline : 426;
    const hud = textAt(canvas, atX(83), baseline, '', 'start', 'graph-hud');
    const result = textAt(canvas, atX(917), baseline, '', 'end', 'graph-result');
    fitReadouts = () => fitGraphReadouts(canvas, hud, result, baseline);
    drawDistances = animateAlgorithm(
      spec,
      root,
      play,
      nodes,
      links,
      hud,
      result,
      calls,
      times,
      end,
      format
    );
  } else animateRelations(spec, play, nodes, links, calls, times, end);
  return {
    cuts: play.cuts,
    seek(seconds: number, reduced?: boolean) {
      play.seek(seconds, reduced);
      drawDistances?.(seconds, reduced);
      fitReadouts?.();
    },
  };
}

export const graphModelGuide = `graph {title,layout?:layered|tree|force|ring,relation?:rank|containment,nodes:[{id,label,group?}],edges:[{from,to,weight?,label?,directed?}],algorithm?:{kind:dijkstra|bfs|dfs|topo-sort,start?,target?},beats:[{at,event,nodes?,winner?,reason?,pair?,prevails?}]}. Reserve tree and relation for directed rank or containment from one root. Use layered, force or ring for algorithm graphs. Dijkstra needs start,target,nonnegative weights. Algorithm cues: start,visit:ID,relax:FROM:TO,done. Relations: reveal,highlight-path(ordered nodes),collapse-subtree(tree),compare(two nodes,winner,reason or pair+prevails). Example {at:"b1",event:"visit:A"}. 1–12 nodes, ≤28 edges.`;
