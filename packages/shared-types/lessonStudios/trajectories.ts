import { curveMonotoneX, line } from 'd3';
import { chart, fitLabel, pill, textAt } from './chart';
import { chartViewport, RELEASE_SCALE, studioViewportScale, WIDTH } from './chartDimensions';
import { MIN_TEXT_GAP_PX } from './layoutValidation';
import { ARRIVE, appear, DIM, EXIT, FOCUS, STAGGER, timeline } from './motion';
import { MIN_TRACE_MOVE, tracePlayback } from './stagedTrace';
import { setProperties } from './timeline';
import { comparisonInterval, type TrajectoriesSpec as Spec } from './trajectoriesSpec';
import { vectorPath } from './vectorPath';
import { type Point, svg, type VectorNode } from './vectorScene';

export {
  checkTrajectoriesSpec,
  TrajectoriesSpecSchema,
  trajectoriesModelGuide,
} from './trajectoriesSpec';

type ScreenPoint = { x: number; y: number };
function placeSeriesLabels(
  surface: VectorNode,
  entries: { label: VectorNode; leader: VectorNode }[],
  gap: number,
  leaderX: number
) {
  let nextTop = chartViewport.top + chartViewport.height;
  const rows = entries.map(({ label, leader }) => ({
    label,
    leader,
    ink: label.glyphs().bounds,
  }));
  const requiredHeight = rows.reduce((height, { ink }) => height + ink.bottom - ink.top, 0);
  if (requiredHeight + (rows.length - 1) * gap > chartViewport.height)
    surface.data.unplacedRequiredLabel = 'true';
  // Push only the overflowing rows up, keeping space for all lower rows.
  for (let i = rows.length - 1; i >= 0; i--) {
    const { label, leader, ink } = rows[i];
    const baseline = Math.min(label.number('y'), nextTop - ink.bottom);
    label.setAttribute('y', baseline);
    leader.setAttribute('x2', leaderX);
    leader.setAttribute('y2', baseline + (ink.top + ink.bottom) / 2);
    nextTop = baseline + ink.top - gap;
  }
  // The reverse pass can squeeze the top. Move that cluster down independently.
  let previousBottom = chartViewport.top - gap;
  for (const { label, leader, ink } of rows) {
    const baseline = Math.max(label.number('y'), previousBottom + gap - ink.top);
    label.setAttribute('y', baseline);
    leader.setAttribute('y2', baseline + (ink.top + ink.bottom) / 2);
    previousBottom = baseline + ink.bottom;
  }
}

// Search by x so the tip and the cursor agree even on steep sections of the same curve.
function pathAtX(path: VectorNode, length: number, x: number) {
  let low = 0,
    high = length;
  for (let i = 0; i < 16; i++) {
    const middle = (low + high) / 2;
    if (vectorPath(path).getPointAtLength(middle).x < x) low = middle;
    else high = middle;
  }
  return { length: high, point: vectorPath(path).getPointAtLength(high) };
}

export function buildTrajectories(spec: Spec, root: VectorNode, beatTimesMs: number[]) {
  const { area, layers, surface, x, y } = chart(
    root,
    [0, 1],
    [0, 1],
    spec.xLabel,
    spec.yLabel,
    false
  );
  const play = timeline();
  const scale = root.viewport ? studioViewportScale(root.viewport) : undefined;
  const end = Number(root.data.durationMs) / 1000;
  tracePlayback(
    root,
    spec.beats.length,
    beatTimesMs.map((ms, index) => ({ index, time: ms / 1000 })),
    end
  );
  const timeAt = (index: number) => (index < 0 ? 0 : (beatTimesMs[index] ?? end * 1000) / 1000);
  const gradient = svg(svg(surface, 'defs', {}), 'linearGradient', { id: 'phase-edges' });
  [0, 0.1, 0.9, 1].forEach((offset, i) =>
    svg(gradient, 'stop', {
      offset,
      'stop-color': 'var(--accent)',
      'stop-opacity': i === 0 || i === 3 ? 0 : 0.12,
    })
  );
  const bandLayer = svg(layers, 'g', {});
  const bands = new Map(
    spec.phases?.map(phase => {
      const group = svg(bandLayer, 'g', {});
      const left = x(phase.start),
        right = x(phase.end);
      setProperties(group, { x: 8, opacity: 0 });
      svg(group, 'rect', {
        class: 'phase',
        x: left,
        y: area.top,
        width: right - left,
        height: area.bottom - area.top,
        fill: 'url(#phase-edges)',
      });
      const label = textAt(
        group,
        (left + right) / 2,
        area.top + 23,
        phase.label,
        'middle',
        'phase-label'
      );
      if (label.glyphs().advance > right - left - 10) {
        if (scale) {
          label.setAttribute('display', 'none');
          if (spec.beats.some(beat => beat.action === 'phase' && beat.target === phase.label))
            surface.data.unplacedRequiredLabel = 'true';
        } else {
          label.setAttribute('textLength', String(Math.max(1, right - left - 10)));
          label.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        }
      }
      return [phase.label, { ...phase, group }] as const;
    })
  );
  const gapLayer = svg(layers, 'g', {});
  const cursorLayer = svg(layers, 'g', {});
  const pathsLayer = svg(surface, 'g', {});
  const labelsLayer = svg(surface, 'g', {});
  const calloutLayer = svg(surface, 'g', {});
  const draw = line<Point>()
    .x(point => x(point[0]))
    .y(point => y(point[1]))
    .curve(curveMonotoneX);
  const series = new Map(
    spec.series.map(({ name, points }, index) => {
      const group = svg(pathsLayer, 'g', {});
      const color = 'var(--chart-' + index + ')';
      group.setAttribute('style', '--series:' + color);
      const path = svg(group, 'path', { class: 'series', d: draw(points) ?? '' });
      const length = vectorPath(path).getTotalLength();
      const first = points[0],
        last = points.at(-1)!;
      const tip = svg(group, 'circle', {
        class: 'series-tip',
        r: 5,
        cx: x(first[0]),
        cy: y(first[1]),
      });
      path.setAttribute('stroke-dasharray', String(length));
      path.setAttribute('stroke-dashoffset', String(length));

      const key = svg(labelsLayer, 'g', { class: 'series-key' });
      const attachment = svg(key, 'g', { visibility: 'hidden' });
      key.setAttribute('style', '--series:' + color);
      const leader = svg(attachment, 'line', { class: 'leader', x1: x(last[0]), y1: y(last[1]) });
      const labelOffset = scale ? MIN_TEXT_GAP_PX / scale + tip.number('r') + 1 : 16;
      const label = textAt(
        attachment,
        area.right + labelOffset,
        y(last[1]) + 5,
        name,
        'start',
        'series-label'
      );
      const maxWidth = WIDTH - area.right - labelOffset - 8;
      if (scale && spec.series.length === 1 && name === spec.yLabel) {
        attachment.setAttribute('display', 'none');
      } else if (scale) {
        if (!fitLabel(label, name, maxWidth)) surface.data.unplacedRequiredLabel = 'true';
      } else if (label.glyphs().advance > maxWidth) {
        label.setAttribute('textLength', String(maxWidth));
        label.setAttribute('lengthAdjust', 'spacingAndGlyphs');
      }
      setProperties(group, { opacity: 0 });
      return [
        name,
        { name, group, path, points, length, first, last, tip, key, attachment, leader, label },
      ] as const;
    })
  );
  placeSeriesLabels(
    surface,
    [...series.values()]
      .filter(entry => entry.attachment.attrs.display !== 'none')
      .sort((a, b) => b.last[1] - a.last[1]),
    Math.ceil(MIN_TEXT_GAP_PX / (scale ?? RELEASE_SCALE)),
    area.right + 10
  );

  const visible = new Set<string>();
  const followTip = new Map<string, (point: ScreenPoint) => void>();
  function reveal(names: string[], time: number, room: number) {
    const pending = names.filter(name => !visible.has(name)).map(name => series.get(name)!);
    if (!pending.length) return time;
    names.forEach(name => visible.add(name));
    const knots = [...new Set(pending.flatMap(entry => entry.points.map(([at]) => x(at))))].sort(
      (a, b) => a - b
    );
    const firstX = knots[0];
    const segments = knots.length - 1;
    const finish = time + Math.min(room, segments * MIN_TRACE_MOVE);
    const starts = tracePlayback(root, segments, [{ index: 0, time }], finish);
    const drawSegments = (render: (value: number, start: number, duration: number) => void) => {
      for (const [i, start] of starts.entries())
        render(knots[i + 1], start, (starts[i + 1] ?? finish) - start);
    };
    const cursor = svg(cursorLayer, 'line', {
      class: 'now-cursor',
      x1: firstX,
      x2: firstX,
      y1: area.top,
      y2: area.bottom,
      opacity: 0,
    });
    const arrival = { ...ARRIVE, duration: Math.min(ARRIVE.duration, finish - time) };
    play.to(cursor, { ...arrival, attr: { opacity: 1 } }, time);
    drawSegments((at, start, duration) =>
      play.to(cursor, { duration, ease: 'none', attr: { x1: at, x2: at } }, start)
    );
    play.to(cursor, { ...EXIT, attr: { opacity: 0 } }, finish);
    pending.forEach(entry => {
      play.to(entry.group, { ...arrival, opacity: 1 }, time);
      const progress = {
        position: firstX,
        get value() {
          return this.position;
        },
        set value(value: number) {
          this.position = value;
          const start = x(entry.first[0]),
            finish = x(entry.last[0]);
          let sample: ReturnType<typeof pathAtX>;
          if (value <= start)
            sample = { length: 0, point: vectorPath(entry.path).getPointAtLength(0) };
          else if (value >= finish)
            sample = {
              length: entry.length,
              point: vectorPath(entry.path).getPointAtLength(entry.length),
            };
          else sample = pathAtX(entry.path, entry.length, value);
          entry.path.setAttribute('stroke-dashoffset', String(entry.length - sample.length));
          entry.tip.setAttribute('cx', String(sample.point.x));
          entry.tip.setAttribute('cy', String(sample.point.y));
          entry.tip.setAttribute('visibility', value < start ? 'hidden' : 'visible');
          entry.attachment.setAttribute('visibility', value < finish ? 'hidden' : 'visible');
          followTip.get(entry.name)?.(sample.point);
        },
      };
      progress.value = firstX;
      drawSegments((at, start, duration) =>
        play.to(progress, { duration, ease: 'none', value: at }, start)
      );
    });
    return finish;
  }

  const initial = [...series.keys()].filter(
    name => !spec.beats.some(beat => beat.action === 'reveal' && beat.target === name)
  );
  const firstBeat = beatTimesMs[0] === undefined ? end : timeAt(0);
  if (firstBeat > 0) reveal(initial, 0, firstBeat);
  let activeBand: ReturnType<typeof bands.get>;
  let activeGap: VectorNode | undefined;
  function compareSeries(
    targets: string[],
    note: ReturnType<typeof pill> | undefined,
    revealedAt: number,
    next: number
  ) {
    const [a, b] = targets.map(name => series.get(name)!);
    const { left, right } = comparisonInterval(a.points, b.points, activeBand);
    const middle = x((left + right) / 2);
    if (right > left) {
      const extent = Array.from({ length: 65 }, (_, i) => x(left + ((right - left) * i) / 64));
      const sample = (entry: typeof a, at: number): Point => [
        at,
        pathAtX(entry.path, entry.length, at).point.y,
      ];
      const upper = extent.map(at => sample(a, at));
      extent.reverse();
      const lower = extent.map(at => sample(b, at));
      const gap = svg(gapLayer, 'path', {
        class: 'series-gap',
        d: 'M' + [...upper, ...lower].join('L') + 'Z',
      });
      activeGap = gap;
      setProperties(gap, { attr: { opacity: 0 } });
      play.to(
        gap,
        { ...ARRIVE, duration: Math.min(ARRIVE.duration, next - revealedAt), attr: { opacity: 1 } },
        revealedAt
      );
      const midpoint = (sample(a, middle)[1] + sample(b, middle)[1]) / 2;
      note?.place(
        [middle, midpoint],
        [middle, midpoint + (midpoint > area.bottom - 85 ? -62 : 62)]
      );
    } else {
      const px = x(a.last[0]),
        py = y(a.last[1]);
      note?.place([px, py], [px - 95, py + 58]);
    }
  }

  function emphasizeSeries(targets: string[], entering: Set<string>, time: number) {
    for (const [name, entry] of series) {
      if (!visible.has(name)) continue;
      const focus = targets.includes(name);
      const opacity = focus ? 1 : DIM;
      if (!entering.has(name) || !focus) play.to(entry.group, { ...FOCUS, opacity }, time);
      play.to(entry.key, { ...FOCUS, opacity }, time);
    }
  }

  function placePhase(name: string, note: ReturnType<typeof pill> | undefined, time: number) {
    const band = bands.get(name)!;
    if (activeBand && activeBand !== band) play.to(activeBand.group, { ...EXIT, opacity: 0 }, time);
    play.to(band.group, { ...(activeBand === band ? FOCUS : ARRIVE), x: 0, opacity: 1 }, time);
    activeBand = band;
    const center = x((band.start + band.end) / 2);
    note?.place([center, area.top + 31], [center, area.top + 69]);
  }

  function placeSeriesNote(name: string, note: ReturnType<typeof pill>, entering: Set<string>) {
    const entry = series.get(name)!;
    const px = x(entry.last[0]),
      py = y(entry.last[1]);
    const place = ({ x, y }: ScreenPoint) => {
      note.place([x, y], [x - 108, Math.min(area.bottom - 25, y + 52)]);
    };
    place({ x: px, y: py });
    if (entering.has(name)) followTip.set(name, place);
  }

  spec.beats.forEach((beat, index) => {
    const time = timeAt(index),
      next = timeAt(index + 1),
      room = next - time;
    const targets = beat.action === 'phase' ? [] : [beat.target].flat();
    const entering = new Set(targets.filter(name => !visible.has(name)));
    const arriving =
      index === 0 && firstBeat === 0 ? [...new Set([...initial, ...targets])] : targets;
    // Give tracing and comparing separate time even when the narration cues are close.
    const compareRoom = beat.action === 'compare' ? Math.min(ARRIVE.duration, room / 2) : 0;
    const revealedAt = reveal(arriving, time, room - compareRoom);
    emphasizeSeries(targets, entering, time);

    const note = beat.label ? pill(calloutLayer, beat.label, 'callout') : undefined;
    if (activeGap) {
      play.to(activeGap, { ...EXIT, attr: { opacity: 0 } }, time);
      activeGap = undefined;
    }
    if (beat.action === 'phase') {
      placePhase(beat.target, note, time);
    } else if (beat.action === 'compare') {
      compareSeries(beat.target, note, revealedAt, next);
    } else if (note) {
      placeSeriesNote(beat.target, note, entering);
    }
    emphasizeActivePhase(beat.action, time);
    if (note)
      appear(
        play,
        note.group,
        time + (beat.action === 'reveal' ? Math.min(STAGGER, room / 4) : 0),
        beatTimesMs[index + 1] === undefined ? Infinity : next
      );
  });
  function emphasizeActivePhase(action: Spec['beats'][number]['action'], time: number) {
    if (!activeBand || action === 'phase') return;
    play.to(activeBand.group, { ...FOCUS, opacity: action === 'compare' ? 1 : DIM }, time);
  }
  return play;
}
