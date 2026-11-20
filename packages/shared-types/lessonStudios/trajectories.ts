import { curveMonotoneX, line } from 'd3';
import * as z from 'zod';
import { chart, pill, textAt } from './chart';
import { WIDTH } from './chartDimensions';
import { geometryBeatFields } from './geometryStudioSpec';
import { ARRIVE, DIM, EXIT, FOCUS, MOVE, STAGGER, appear, timeline } from './motion';
import { tracePlayback } from './stagedTrace';
import { motionEase, setProperties } from './timeline';
import { vectorPath } from './vectorPath';
import { type Point, svg, type VectorNode } from './vectorScene';

type ScreenPoint = { x: number; y: number };
export const trajectoriesModelGuide = `trajectories spec {title,xLabel,yLabel,series:[{name,points:[[x,y],...]}],phases?:[{label,start,end}],beats:[{at,action,target}]}. 1–6 uniquely named series; 3–8 normalized points (0–1), strictly ascending x. Phases have unique labels and 0≤start<end≤1. Actions: reveal (target series name), phase (target phase label), compare (target array of two distinct series names). Qualitative curves are illustrative, not measured data. Use meaningful axis names, e.g. {at:"b1",action:"compare",target:["A","B"]}.`;
const label = z.string().trim().min(1);
const unit = z.number().min(0).max(1);
const points = z
  .array(z.tuple([unit, unit]))
  .min(3)
  .max(8)
  .refine(
    points => points.every(([x], i) => i === 0 || x > points[i - 1][0]),
    'Points must have strictly ascending x'
  );
const phases = z.array(
  z
    .strictObject({ label, start: unit, end: unit })
    .refine(phase => phase.start < phase.end, 'Phase start must precede end')
);
export const TrajectoriesSpecSchema = z
  .strictObject({
    title: label,
    xLabel: label,
    yLabel: label,
    series: z
      .array(z.strictObject({ name: label, points }))
      .min(1)
      .max(6),
    phases: phases.optional(),
    beats: z.array(
      z.discriminatedUnion('action', [
        z.strictObject({ ...geometryBeatFields, action: z.literal('reveal'), target: label }),
        z.strictObject({ ...geometryBeatFields, action: z.literal('phase'), target: label }),
        z.strictObject({
          ...geometryBeatFields,
          action: z.literal('compare'),
          target: z
            .tuple([label, label])
            .refine(names => names[0] !== names[1], 'Compare two distinct series'),
        }),
      ])
    ),
  })
  .superRefine((spec, ctx) => {
    const names = new Set(spec.series.map(series => series.name));
    const phases = new Set(spec.phases?.map(phase => phase.label));
    if (names.size !== spec.series.length)
      ctx.addIssue({ code: 'custom', path: ['series'], message: 'Series names must be unique' });
    if (phases.size !== (spec.phases?.length ?? 0))
      ctx.addIssue({ code: 'custom', path: ['phases'], message: 'Phase labels must be unique' });
    spec.beats.forEach((beat, index) => {
      const valid =
        beat.action === 'phase'
          ? phases.has(beat.target)
          : beat.action === 'compare'
            ? beat.target.every(name => names.has(name))
            : names.has(beat.target);
      if (!valid)
        ctx.addIssue({
          code: 'custom',
          path: ['beats', index, 'target'],
          message: 'Unknown series or phase',
        });
    });
  });
type Spec = z.infer<typeof TrajectoriesSpecSchema>;

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
        label.setAttribute('textLength', String(Math.max(1, right - left - 10)));
        label.setAttribute('lengthAdjust', 'spacingAndGlyphs');
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
      const attachment = svg(key, 'g', {});
      key.setAttribute('style', '--series:' + color);
      const leader = svg(attachment, 'line', { class: 'leader', x1: x(last[0]), y1: y(last[1]) });
      const label = textAt(
        attachment,
        area.right + 16,
        y(last[1]) + 5,
        name,
        'start',
        'series-label'
      );
      const maxWidth = WIDTH - area.right - 24;
      if (label.glyphs().advance > maxWidth) {
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
  let labelY = area.top - 24;
  for (const entry of [...series.values()].sort((a, b) => b.last[1] - a.last[1])) {
    labelY = Math.max(y(entry.last[1]), labelY + 24);
    entry.label.setAttribute('y', String(labelY + 5));
    entry.leader.setAttribute('x2', String(area.right + 10));
    entry.leader.setAttribute('y2', String(labelY));
  }
  const labelOverflow = Math.max(0, labelY - area.bottom);
  if (labelOverflow > 0)
    for (const entry of series.values()) {
      entry.label.setAttribute('y', String(Number(entry.label.attrs.y) - labelOverflow));
      entry.leader.setAttribute('y2', String(Number(entry.leader.attrs.y2) - labelOverflow));
    }

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
          const sample =
            value <= start
              ? { length: 0, point: vectorPath(entry.path).getPointAtLength(0) }
              : value >= finish
                ? {
                    length: entry.length,
                    point: vectorPath(entry.path).getPointAtLength(entry.length),
                  }
                : pathAtX(entry.path, entry.length, value);
          entry.path.setAttribute('stroke-dashoffset', String(entry.length - sample.length));
          entry.tip.setAttribute('cx', String(sample.point.x));
          entry.tip.setAttribute('cy', String(sample.point.y));
          entry.tip.setAttribute('visibility', value < start ? 'hidden' : 'visible');
          followTip.get(entry.name)?.(sample.point);
        },
      };
      progress.value = firstX;
      drawSegments((at, start, duration) =>
        play.to(progress, { duration, ease: 'none', x: at, lazy: false }, start)
      );
      const at = knots.indexOf(x(entry.last[0]));
      appear(play, entry.attachment, starts[at] ?? finish);
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
  spec.beats.forEach((beat, index) => {
    const time = timeAt(index),
      next = timeAt(index + 1),
      room = next - time;
    const targets = beat.action === 'phase' ? [] : [beat.target].flat();
    const entering = new Set(targets.filter(name => !visible.has(name)));
    const arriving =
      index === 0 && firstBeat === 0 ? [...new Set([...initial, ...targets])] : targets;
    const revealedAt = reveal(arriving, time, room);
    for (const [name, entry] of series) {
      if (!visible.has(name)) continue;
      const focus = targets.includes(name);
      const opacity = focus ? 1 : DIM;
      if (!entering.has(name) || !focus) play.to(entry.group, { ...FOCUS, opacity }, time);
      play.to(entry.key, { ...FOCUS, opacity }, time);
    }

    const note = beat.label ? pill(calloutLayer, beat.label, 'callout') : undefined;
    if (activeGap) {
      play.to(activeGap, { ...EXIT, attr: { opacity: 0 } }, time);
      activeGap = undefined;
    }
    if (beat.action === 'phase') {
      const band = bands.get(beat.target)!;
      if (activeBand && activeBand !== band)
        play.to(activeBand.group, { ...EXIT, opacity: 0 }, time);
      play.to(band.group, { ...(activeBand === band ? FOCUS : ARRIVE), x: 0, opacity: 1 }, time);
      activeBand = band;
      const center = x((band.start + band.end) / 2);
      note?.place([center, area.top + 31], [center, area.top + 69]);
    } else if (beat.action === 'compare') {
      const [a, b] = beat.target.map(name => series.get(name)!);
      const left = Math.max(a.first[0], b.first[0], activeBand?.start ?? 0);
      const right = Math.min(a.last[0], b.last[0], activeBand?.end ?? 1);
      const middle = x((left + right) / 2);
      if (right > left) {
        const extent = Array.from({ length: 65 }, (_, i) => x(left + ((right - left) * i) / 64));
        const sample = (entry: typeof a, at: number): Point => [
          at,
          pathAtX(entry.path, entry.length, at).point.y,
        ];
        const upper = extent.map(at => sample(a, at));
        const lower = extent.reverse().map(at => sample(b, at));
        const gap = svg(gapLayer, 'path', {
          class: 'series-gap',
          d: 'M' + [...upper, ...lower].join('L') + 'Z',
        });
        activeGap = gap;
        setProperties(gap, { attr: { opacity: 0 } });
        play.to(gap, { ...ARRIVE, attr: { opacity: 1 } }, revealedAt);
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
    } else if (note) {
      const entry = series.get(beat.target)!;
      const px = x(entry.last[0]),
        py = y(entry.last[1]);
      const place = (point: ScreenPoint) => {
        const { x, y } = point;
        note?.place([x, y], [x - 108, Math.min(area.bottom - 25, y + 52)]);
      };
      place({ x: px, y: py });
      if (entering.has(beat.target)) followTip.set(beat.target, place);
    }
    if (activeBand && beat.action !== 'phase') {
      play.to(activeBand.group, { ...FOCUS, opacity: beat.action === 'compare' ? 1 : DIM }, time);
    }
    if (note)
      appear(
        play,
        note.group,
        time + (beat.action === 'reveal' ? Math.min(STAGGER, room / 4) : 0),
        beatTimesMs[index + 1] === undefined ? Infinity : next
      );
  });
  return play;
}
