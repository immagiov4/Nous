import { HEIGHT, studioStage, WIDTH } from './chartDimensions';
import { DISTINCT_LABEL_GAP_PX, MIN_TEXT_GAP_PX } from './layoutValidation';
import { MOVE } from './motion';
import { motionEase, type StudioTimeline } from './timeline';
import { type Box, boxDistance, enclosingBoxes, isVisible, overlaps } from './vectorBounds';
import { absolutePosition, descendants, type Point, type VectorNode } from './vectorScene';

type StageRect = { x: number; y: number; width: number; height: number };

function stageBox(rect: StageRect): Box {
  return {
    left: rect.x + margin,
    top: rect.y + margin,
    right: rect.x + rect.width - margin,
    bottom: rect.y + rect.height - margin,
  };
}

function readerStage(viewport: VectorNode['viewport']): StageRect {
  const { top, width, height } = studioStage(viewport);
  return { x: 0, y: top, width, height };
}

function clearBox(box: Box, area: Box, occupied: Box[]) {
  return (
    box.left >= area.left &&
    box.top >= area.top &&
    box.right <= area.right &&
    box.bottom <= area.bottom &&
    !occupied.some(other => overlaps(box, other))
  );
}

const ordered = (values: number[], origin: number) =>
  [...new Set(values)].sort((a, b) => Math.abs(a - origin) - Math.abs(b - origin));

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

export function nearestClearBox(
  preferred: Box,
  area: Box,
  occupied: Box[],
  accepts: (box: Box) => boolean = () => true
) {
  const fits = (box: Box) => clearBox(box, area, occupied) && accepts(box);
  if (fits(preferred)) return preferred;
  const [cx, cy] = center(preferred);
  const w = preferred.right - preferred.left,
    h = preferred.bottom - preferred.top;
  const at = (x: number, y: number) => ({
    left: x - w / 2,
    right: x + w / 2,
    top: y - h / 2,
    bottom: y + h / 2,
  });
  // An axis-aligned rectangle can skim a stage or obstacle boundary at its closest free point.
  const cxInStage = clamp(cx, area.left + w / 2, area.right - w / 2);
  const cyInStage = clamp(cy, area.top + h / 2, area.bottom - h / 2);
  const xs = [cxInStage, area.left + w / 2, area.right - w / 2];
  const ys = [cyInStage, area.top + h / 2, area.bottom - h / 2];
  for (const box of occupied) {
    xs.push(box.left - w / 2 - 1, box.right + w / 2 + 1);
    ys.push(box.top - h / 2 - 1, box.bottom + h / 2 + 1);
  }
  let best: Box | undefined;
  let score = Infinity;
  const yCandidates = ordered(ys, cy);
  for (const x of ordered(xs, cx)) {
    const horizontal = (x - cx) ** 2;
    if (horizontal >= score) break;
    for (const y of yCandidates) {
      const distance = horizontal + (y - cy) ** 2;
      if (distance >= score) break;
      const candidate = at(x, y);
      if (!fits(candidate)) continue;
      best = candidate;
      score = distance;
      break;
    }
  }
  return best;
}

type Placement = {
  target: Point;
  desired: Point;
  initial: Point;
  body: VectorNode;
  leader: VectorNode;
  width: number;
  height: number;
};
const placements = new WeakMap<VectorNode, Placement>();
export function rememberCallout(group: VectorNode, placement: Placement) {
  if (!group.hasClass('callout')) return;
  group.data.calloutAnchor = placement.target.join(',');
  placements.set(group, placement);
}

const directions: Point[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];
const distances = [38, 82];
const closeGap = 12;
const margin = 8;
const fits = (box: Box, stage: StageRect) => clearBox(box, stageBox(stage), []);
const inside = ([x, y]: Point, box: Box, pad = 0) =>
  x >= box.left - pad && x <= box.right + pad && y >= box.top - pad && y <= box.bottom + pad;
const center = (box: Box): Point => [(box.left + box.right) / 2, (box.top + box.bottom) / 2];

function boundary(box: Box, towards: Point, ellipse = false): Point {
  const [x, y] = center(box);
  const dx = towards[0] - x,
    dy = towards[1] - y;
  const rx = (box.right - box.left) / 2,
    ry = (box.bottom - box.top) / 2;
  const extent = ellipse
    ? Math.hypot(dx / rx, dy / ry)
    : Math.max(Math.abs(dx / rx), Math.abs(dy / ry));
  return extent ? [x + dx / extent, y + dy / extent] : [x, y];
}

function crosses([ax, ay]: Point, [bx, by]: Point, box: Box) {
  const dx = bx - ax,
    dy = by - ay;
  const noX = ax > box.left && ax < box.right ? -Infinity : Infinity;
  const noY = ay > box.top && ay < box.bottom ? -Infinity : Infinity;
  const x1 = dx ? (box.left - ax) / dx : noX;
  const x2 = dx ? (box.right - ax) / dx : -x1;
  const y1 = dy ? (box.top - ay) / dy : noY;
  const y2 = dy ? (box.bottom - ay) / dy : -y1;
  if ((!dx && x1 === Infinity) || (!dy && y1 === Infinity)) return false;
  return (
    Math.max(0.02, Math.min(x1, x2), Math.min(y1, y2)) <
    Math.min(0.98, Math.max(x1, x2), Math.max(y1, y2))
  );
}

type Route = [Point, Point, Point];
type Pose = { box: Box; route?: Route; opacity?: number };
type Motion = { from: Pose; to: Pose; start: number; anchor: Point };
type Probe = { time: number; progress: number; boxes: Box[] };
type RelativeProbe = Probe & { anchorDelta: Point };
type Obstacles = ReturnType<typeof enclosingBoxes>;
type Scene = Pick<StudioTimeline, 'seek' | 'cuts'>;
type Frame = { time: number; poses: Map<VectorNode, Motion> };
type LayoutSample = {
  time: number;
  scene: Obstacles;
  visible: Map<VectorNode, { placement: Placement; offset: Point }>;
};
type Interval = { start: number; end: number; samples: number[] };
type PlacementFrame = {
  placement: Placement;
  secondary: boolean;
  offset: Point;
  scene: Obstacles;
  placed: Box[];
  competing: Box[];
  swept: Box[];
  ahead: Box[];
  lifetime: Box[];
  probes: RelativeProbe[];
  prior?: Motion;
  start: number;
};

const move = motionEase(MOVE.ease);
const beforeCut = 0.00001;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const offset = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const movePoint = ([x, y]: Point, [dx, dy]: Point): Point => [x + dx, y + dy];
const moveBox = ({ left, top, right, bottom }: Box, [dx, dy]: Point): Box => ({
  left: left + dx,
  top: top + dy,
  right: right + dx,
  bottom: bottom + dy,
});
const shiftPose = (pose: Pose, delta: Point): Pose => ({
  ...pose,
  box: moveBox(pose.box, delta),
  route: pose.route?.map(point => movePoint(point, delta)) as Route | undefined,
});
const sampleAnchor = ({ placement, offset }: { placement: Placement; offset: Point }) =>
  movePoint(placement.target, offset);

function rebase(motion: Motion | undefined, anchor: Point): Motion | undefined {
  if (!motion) return;
  const delta = offset(anchor, motion.anchor);
  if (!delta.some(Boolean)) return motion;
  const from = shiftPose(motion.from, delta);
  return {
    from,
    to: motion.to === motion.from ? from : shiftPose(motion.to, delta),
    anchor,
    start: motion.start,
  };
}

function motionAt({ from, to, start }: Motion, seconds: number) {
  const t = move(Math.max(0, Math.min(1, (seconds - start) / MOVE.duration)));
  const a = center(from.box),
    b = center(to.box);
  const position: Point = [mix(a[0], b[0], t), mix(a[1], b[1], t)];
  const shiftRoute = (route: Route, source: Point, target: Point): Route => [
    route[0],
    route[1],
    [route[2][0] + target[0] - source[0], route[2][1] + target[1] - source[1]],
  ];
  const arrival = to.route ?? (from.route && shiftRoute(from.route, a, b));
  const departure = from.route ?? (to.route && shiftRoute(to.route, b, a));
  const route =
    arrival &&
    departure &&
    (departure.map(([x, y], i): Point => [mix(x, arrival[i][0], t), mix(y, arrival[i][1], t)]) as
      | Route
      | undefined);
  const opacity = mix(from.opacity ?? Number(!!from.route), to.opacity ?? Number(!!to.route), t);
  return { position, route, opacity };
}

function poseAt(motion: Motion, seconds: number): Pose {
  const { position, route, opacity } = motionAt(motion, seconds);
  const box = motion.to.box,
    [x, y] = center(box);
  const dx = position[0] - x,
    dy = position[1] - y;
  return {
    box: { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy },
    route,
    opacity,
  };
}

const straightRoute = ([start, end]: [Point, Point]): Route => [
  start,
  [mix(start[0], end[0], 0.5), mix(start[1], end[1], 0.5)],
  end,
];

function reusePose(
  pose: Pose,
  {
    clearSegment,
    leaderFor,
  }: {
    clearSegment: (start: Point, end: Point) => boolean;
    leaderFor: (box: Box) => Route | undefined;
  }
): Pose {
  const { box, route: path } = pose;
  if (path && clearSegment(path[0], path[1]) && clearSegment(path[1], path[2])) return pose;
  const route = leaderFor(box);
  return !path && !route ? pose : { box, route };
}

function focusGeometry(scene: Obstacles, focus: Point) {
  const containing = scene
    .filter(({ boxes }) => boxes.length === 1 && inside(focus, boxes[0], 2))
    .sort((a, b) => area(a.boxes[0]) - area(b.boxes[0]));
  const outline =
    containing.find(({ element }) => element.tag === 'rect' || element.tag === 'circle') ??
    containing.find(({ element }) => element.tag === 'text');
  const focusedStroke = outline
    ? undefined
    : scene
        .flatMap(({ boxes }) => boxes.filter(box => inside(focus, box)))
        .sort((a, b) => area(a) - area(b))[0];
  const outlineBox = outline?.boxes[0] ?? focusedStroke;
  const anchor = outlineBox ? center(outlineBox) : focus;
  return { outline, outlineBox, anchor };
}

function solve({
  placement,
  secondary,
  offset: parentOffset,
  scene,
  placed,
  competing,
  swept,
  ahead,
  lifetime,
  probes,
  prior,
  start,
}: PlacementFrame): Pose | undefined {
  const { target, desired, width, height } = placement;
  const stage =
    secondary || placement.body.viewport
      ? readerStage(placement.body.viewport)
      : { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const focus = movePoint(target, parentOffset);
  const preferred = prior ? center(prior.to.box) : movePoint(desired, parentOffset);
  const origin = prior && motionAt(prior, start).position;
  const rx = width / 2 + 1;
  const ry = height / 2 + 1;
  const { outline, outlineBox, anchor } = focusGeometry(scene, focus);
  const closest = (box: Box) =>
    Math.hypot(box.left + rx - preferred[0], box.top + ry - preferred[1]);
  const at = ([x, y]: Point): Box => ({ left: x - rx, right: x + rx, top: y - ry, bottom: y + ry });
  const outlineHalfWidth = outlineBox ? (outlineBox.right - outlineBox.left) / 2 : 0;
  const outlineHalfHeight = outlineBox ? (outlineBox.bottom - outlineBox.top) / 2 : 0;
  const around = (gaps: number[]) =>
    gaps
      .flatMap(gap =>
        directions.map(([dx, dy]) =>
          at([
            anchor[0] + dx * (rx + gap + outlineHalfWidth),
            anchor[1] + dy * (ry + gap + outlineHalfHeight),
          ])
        )
      )
      .sort((a, b) => closest(a) - closest(b));
  const occupied = [...scene.flatMap(item => item.boxes), ...placed];
  const leaderObstacles = [
    ...scene.flatMap(item =>
      item.element.attrs['data-callout-leader-through'] !== undefined
        ? []
        : item.boxes.filter(box => box !== outlineBox)
    ),
    ...placed,
  ];
  const clearLabels = (box: Box) =>
    competing.every(other => boxDistance(box, other) >= DISTINCT_LABEL_GAP_PX);
  const gap = secondary && placement.body.viewport ? MIN_TEXT_GAP_PX : 0;
  const clashes = (box: Box, other: Box) =>
    gap ? boxDistance(box, other) < gap : overlaps(box, other);
  const free = (box: Box) =>
    fits(box, stage) && !occupied.some(other => clashes(box, other)) && clearLabels(box);
  const onStage = (box: Box, anchorDelta: Point) => fits(moveBox(box, anchorDelta), stage);
  const clearThroughout = (box: Box) =>
    free(box) &&
    probes.every(({ anchorDelta }) => onStage(box, anchorDelta)) &&
    !swept.some(other => clashes(box, other));
  const clearAcrossMotion = (box: Box) => {
    if (!origin) return clearThroughout(box);
    if (!free(box)) return false;
    const [x, y] = center(box);
    return probes.every(({ progress, boxes, anchorDelta }) => {
      const chip = at([mix(origin[0], x, progress), mix(origin[1], y, progress)]);
      return onStage(chip, anchorDelta) && !boxes.some(other => clashes(chip, other));
    });
  };
  const terminals = (box: Box, bend?: Point): [Point, Point] => {
    const end = boundary(box, bend ?? anchor);
    const towards = bend ?? end;
    const start = outlineBox
      ? boundary(outlineBox, towards, outline?.element.tag === 'circle')
      : focus;
    return [start, end];
  };
  const clearSegment = (start: Point, end: Point) =>
    !leaderObstacles.some(other => crosses(start, end, other));
  const straightLeader = (box: Box) => {
    const [start, end] = terminals(box);
    return clearSegment(start, end);
  };
  const bentLeader = (box: Box): Route | undefined => {
    const [x, y] = center(box);
    const elbows: Point[] = [
      [x, anchor[1]],
      [anchor[0], y],
    ];
    for (const bend of elbows) {
      if (occupied.some(other => inside(bend, other, 1)) || inside(bend, box, 1)) continue;
      const [start, end] = terminals(box, bend);
      if (clearSegment(start, bend) && clearSegment(bend, end)) return [start, bend, end];
    }
  };
  const clearAhead = (box: Box) => !ahead.some(other => clashes(box, other));
  const clearLifetime = (box: Box) => !lifetime.some(other => clashes(box, other));
  const leaderFor = (box: Box) =>
    straightLeader(box) ? straightRoute(terminals(box)) : bentLeader(box);
  if (prior && clearAcrossMotion(prior.to.box) && clearAhead(prior.to.box)) {
    return reusePose(prior.to, { clearSegment, leaderFor });
  }
  const picked = selectPlacement({
    preferred: at(preferred),
    rings: { far: around(distances), close: around([closeGap]) },
    grid: () => placementGrid({ stage, rx, ry, at, closest }),
    clearAcrossMotion,
    clearThroughout,
    clearAhead,
    clearLifetime,
    straightLeader,
    bentLeader,
    fallback: () =>
      nearestClearBox(at(preferred), stageBox(stage), [...occupied, ...swept], clearLabels),
    free,
    stage,
    prior,
    requireClearance: secondary,
  });
  if (!picked) return;
  const { box, route } = picked;
  return {
    box,
    route: route ?? leaderFor(box),
  };
}

type FitsBox = (box: Box) => boolean;

function placementGrid({
  stage,
  rx,
  ry,
  at,
  closest,
}: {
  stage: StageRect;
  rx: number;
  ry: number;
  at: (point: Point) => Box;
  closest: (box: Box) => number;
}) {
  const extra: Box[] = [];
  const step = 12;
  for (let y = stage.y + ry + margin; y <= stage.y + stage.height - ry - margin; y += step) {
    for (let x = stage.x + rx + margin; x <= stage.x + stage.width - rx - margin; x += step) {
      extra.push(at([x, y]));
    }
  }
  extra.sort((a, b) => closest(a) - closest(b));
  return extra;
}

function findBentPlacement(candidates: Box[], leader: (box: Box) => Route | undefined) {
  for (const box of candidates) {
    const route = leader(box);
    if (route) return { box, route };
  }
}

function selectPlacement({
  preferred,
  rings,
  grid,
  clearAcrossMotion,
  clearThroughout,
  clearAhead,
  clearLifetime,
  straightLeader,
  bentLeader,
  fallback: fallbackBox,
  free,
  stage,
  prior,
  requireClearance,
}: {
  preferred: Box;
  rings: { far: Box[]; close: Box[] };
  grid: () => Box[];
  clearAcrossMotion: FitsBox;
  clearThroughout: FitsBox;
  clearAhead: FitsBox;
  clearLifetime: FitsBox;
  straightLeader: FitsBox;
  bentLeader: (box: Box) => Route | undefined;
  fallback: () => Box | undefined;
  free: FitsBox;
  stage: StageRect;
  prior?: Motion;
  requireClearance: boolean;
}) {
  const candidates = [preferred, ...rings.far, ...rings.close];
  const empty = candidates.filter(box => clearAcrossMotion(box) && clearAhead(box));
  if (requireClearance) {
    const safe = (box: Box) => clearAcrossMotion(box) && clearAhead(box) && clearLifetime(box);
    const box = empty.find(clearLifetime) ?? grid().find(safe);
    return box ? { box } : undefined;
  }
  let selected = empty.find(box => clearLifetime(box) && straightLeader(box));
  let route: Route | undefined;
  if (!selected) {
    // Dense diagrams can require a position beyond the rings around the focus.
    const extra = grid();
    const futureSafe = (box: Box) => clearAcrossMotion(box) && clearAhead(box);
    selected = extra.find(box => futureSafe(box) && clearLifetime(box) && straightLeader(box));
    const fallback = selected ? [] : extra.filter(futureSafe);
    selected ??= empty.find(straightLeader) ?? fallback.find(straightLeader);
    if (!selected) {
      const bent = findBentPlacement([...empty, ...fallback], bentLeader);
      selected = bent?.box;
      route = bent?.route;
    }
    selected ??=
      empty[0] ??
      fallback[0] ??
      (prior && clearAcrossMotion(prior.to.box) ? prior.to.box : undefined) ??
      candidates.find(clearAcrossMotion) ??
      extra.find(clearAcrossMotion) ??
      candidates.find(clearThroughout) ??
      extra.find(clearThroughout) ??
      fallbackBox() ??
      candidates.find(free) ??
      extra.find(free) ??
      candidates.find(box => fits(box, stage));
  }
  return selected ? { box: selected, route } : undefined;
}

export function isWithinCallout(element: VectorNode) {
  for (let ancestor: VectorNode | undefined = element; ancestor; ancestor = ancestor.parent) {
    if (ancestor.hasClass('callout')) return true;
  }
  return false;
}

const canOmitCallout = (group: VectorNode) =>
  group.viewport !== undefined && group.data.secondaryLabel === 'true';

function probeTimes(cuts: number[], duration: number) {
  const intervals: Interval[] = [];
  for (let start = 0; start <= duration; ) {
    const nextCut = cuts.find(cut => cut > start + beforeCut) ?? Infinity;
    const end = Math.min(start + MOVE.duration, nextCut);
    const span = end - start;
    const samples = [
      start,
      start + span / 5,
      start + span / 2,
      start + (span * 4) / 5,
      end - beforeCut,
    ];
    intervals.push({ start, end, samples });
    start = end;
  }
  return intervals;
}

function sampleScene(
  surface: VectorNode,
  source: Scene,
  groups: VectorNode[],
  intervals: Interval[]
) {
  const times = [...new Set(intervals.flatMap(({ samples }) => samples))].sort((a, b) => a - b);
  return new Map(
    times.map(time => {
      source.seek(time);
      const shown: LayoutSample['visible'] = new Map();
      for (const group of groups) {
        const placement = placements.get(group);
        if (!placement || !isVisible(group)) continue;
        shown.set(group, { placement, offset: absolutePosition(group.parent) });
      }
      const scene = shown.size
        ? enclosingBoxes(surface).filter(({ element }) => !isWithinCallout(element))
        : [];
      return [time, { time, scene, visible: shown }];
    })
  );
}

function planFrame(
  { start, end, samples }: Interval,
  geometry: Map<number, LayoutSample>,
  previous: Map<VectorNode, Motion>,
  persistent: Map<VectorNode, Box[]>
) {
  const window = samples.map(time => geometry.get(time)!);
  const previews = [...geometry.values()].filter(
    sample => sample.time >= end && sample.time <= end + MOVE.duration
  );
  const shown = new Map(
    window.flatMap(sample => [...sample.visible.keys()].map(group => [group, sample] as const))
  );
  const probes: Probe[] = window.map(({ time, scene }) => ({
    time,
    progress: move((time - start) / MOVE.duration),
    boxes: scene.flatMap(item => item.boxes),
  }));
  const placed: { group: VectorNode; box: Box; anchor: Point }[] = [];
  const poses = new Map<VectorNode, Motion>();
  for (const [group, lastShown] of shown) {
    const sample = lastShown.visible.get(group)!;
    const anchor = sampleAnchor(sample);
    const prior = rebase(previous.get(group), anchor);
    const relativeBoxes = (boxes: Box[], from: LayoutSample) => {
      const delta = offset(anchor, sampleAnchor(from.visible.get(group)!));
      return boxes.map(box => moveBox(box, delta));
    };
    const activeProbes = relativeProbes(probes, geometry, group, anchor);
    const swept = distinctBoxes(activeProbes.flatMap(probe => probe.boxes));
    const upcoming = distinctBoxes(
      previews
        .filter(sample => sample.visible.has(group))
        .flatMap(sample =>
          relativeBoxes(
            sample.scene.flatMap(item => item.boxes),
            sample
          )
        )
    );
    const competing = placed.filter(
      other =>
        (other.anchor[0] !== anchor[0] || other.anchor[1] !== anchor[1]) &&
        window.some(frame => frame.visible.has(group) && frame.visible.has(other.group))
    );
    const to = solve({
      ...sample,
      secondary: canOmitCallout(group),
      scene: lastShown.scene,
      placed: placed.map(other => other.box),
      competing: competing.map(other => other.box),
      swept,
      ahead: upcoming,
      lifetime: prior ? [] : (persistent.get(group) ?? []),
      probes: activeProbes,
      prior,
      start,
    });
    if (!to) continue;
    placed.push({ group, box: to.box, anchor });
    const motion =
      to === prior?.to ? prior : { from: prior ? poseAt(prior, start) : to, to, start, anchor };
    poses.set(group, motion);
    for (const probe of probes) {
      const current = geometry.get(probe.time)!.visible.get(group);
      if (current)
        probe.boxes.push(
          moveBox(poseAt(motion, probe.time).box, offset(sampleAnchor(current), anchor))
        );
    }
  }
  return poses;
}

function relativeProbes(
  probes: Probe[],
  geometry: Map<number, LayoutSample>,
  group: VectorNode,
  anchor: Point
): RelativeProbe[] {
  return probes.flatMap(probe => {
    const sample = geometry.get(probe.time)?.visible.get(group);
    if (!sample) return [];
    const position = sampleAnchor(sample);
    const relative = offset(anchor, position);
    return [
      {
        ...probe,
        boxes: probe.boxes.map(box => moveBox(box, relative)),
        anchorDelta: offset(position, anchor),
      },
    ];
  });
}

const distinctBoxes = (boxes: Box[]) => [
  ...new Map(
    boxes.map(box => [[box.left, box.top, box.right, box.bottom].join(','), box])
  ).values(),
];

function paint(group: VectorNode, placement: Placement, motion: Motion, seconds: number) {
  const { body, leader, target } = placement;
  const { position, route, opacity } = motionAt(motion, seconds);
  const anchor = movePoint(target, absolutePosition(group.parent));
  const delta = offset(anchor, motion.anchor);
  const centerOnStage = movePoint(position, delta);
  // A moving parent or an instantaneous reduced-motion step can outrun the sampled placement.
  if (
    canOmitCallout(group) &&
    !fits(calloutBox(placement, centerOnStage), readerStage(placement.body.viewport))
  ) {
    hideCallout(placement);
    return;
  }
  const local = absolutePosition(group);
  body.removeAttribute('visibility');
  [body.x, body.y] = offset(centerOnStage, local);
  leader.setAttribute('visibility', route ? 'visible' : 'hidden');
  leader.opacity = opacity;
  if (route) {
    leader.setAttribute(
      'points',
      route.map(point => offset(movePoint(point, delta), local).join(',')).join(' ')
    );
  }
}

function calloutBox({ width, height }: Placement, [x, y]: Point): Box {
  return { left: x - width / 2, right: x + width / 2, top: y - height / 2, bottom: y + height / 2 };
}

function hideCallout({ body, leader }: Placement) {
  body.setAttribute('visibility', 'hidden');
  leader.setAttribute('visibility', 'hidden');
}

function resetCallout({ body, leader, initial, target }: Placement) {
  [body.x, body.y] = initial;
  leader.setAttribute('points', `${target.join(',')} ${initial.join(',')}`);
  leader.removeAttribute('visibility');
  leader.opacity = undefined;
}

/** Probe the same vector scene that playback will paint. The scene is seekable, so there is no clone. */
export function planCallouts(surface: VectorNode, scene: Scene, duration: number) {
  const groups = [...descendants(surface)].filter(node => node.hasClass('callout'));
  const intervals = groups.length
    ? probeTimes(
        [...scene.cuts].sort((a, b) => a - b),
        duration
      )
    : [];
  const samples = sampleScene(surface, scene, groups, intervals);
  let previous = new Map<VectorNode, Motion>();
  const frames: Frame[] = intervals.map(interval => {
    previous = planFrame(interval, samples, previous, new Map());
    return { time: interval.end, poses: previous };
  });
  return (seconds: number) => {
    const frame = frames.find(candidate => candidate.time > seconds) ?? frames.at(-1);
    for (const group of groups) {
      const placement = placements.get(group);
      if (!placement) continue;
      const motion = isVisible(group) ? frame?.poses.get(group) : undefined;
      if (motion) {
        paint(group, placement, motion, seconds);
      } else {
        resetCallout(placement);
        if (canOmitCallout(group)) hideCallout(placement);
      }
    }
  };
}

const area = (box: Box) => (box.right - box.left) * (box.bottom - box.top);
