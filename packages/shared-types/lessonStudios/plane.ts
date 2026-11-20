import { plotArea as box, chart, pill } from './chart';
import { placeDiagramLabels } from './labelPlacement';
import { ARRIVE, DIM, EXIT, FOCUS, MOVE, markCalloutWindow, RISE } from './motion';
import { planeCopy as copy } from './plane.copy.it';
import { planeDrawing } from './planeDraw';
import { mix, snell } from './planeMath';
import { parameterFrames, type Spec } from './planeSpec';
import { tracePlayback } from './stagedTrace';
import { motionEase } from './timeline';
import { descendants, type Point, svg, type VectorNode } from './vectorScene';

const axisClasses = ['grid', 'axis', 'tick', 'axis-label'];
export const planeModelGuide =
  'plane {title,x:[min,max],y:[min,max],axes?:[x,y],grid?,parameters?,layers:[{id,type,name?,…}],beats:[{at,callout?,focus:[id],set?,show?}]}. show replaces visible IDs. curve expr; line form:{m,b}|[point,point]; point at:[x,y]; segment/vector/construction through:[point,point], horizon?; floor vanishing,near:[left,right],tiles,rows,part?; region between:[id,id],where:above/below; grid-transform matrix; intersection of:[id,id]; roots of:id; tangent of:id,x,h; snell n1,n2,angle,media?:[{index,name}]. Example {id:"f",type:"curve",expr:"x^2"}. circle {center:[x,y],radius}; unit-circle-wave {angle:"theta",waveStart:1.5,sineName?,cosineName?} draws a rotating point, radius, angle and projections and traces sin(theta) when beat has wave:true. Use x:[-1.3,8],y:[-1.25,1.25],grid:false, parameters:{theta:0}; set theta in degrees (30, 90, 180, then 360 with wave:true). Select that layer through the unit-circle and sine-wave explanation. parameters and every beat.set are flat maps from declared scalars to numbers. x is reserved for curve expressions: use a or h to drive tangent.x and tangent.h. For a grid transformation, start from identity, first move i, then j, retain the unit square and show its transformed area; add a rank-deficient matrix only when narrated. Use scale:"independent" only for unrelated units (e.g. price versus demand), never for geometry. Explicitly use show for visual objects that enter or leave, and focus only the labels needed in each beat. Construction, floor and Snell use axes only for measured quantities.';
const easing = {
  move: motionEase(MOVE.ease),
  focus: motionEase(FOCUS.ease),
  arrive: motionEase(ARRIVE.ease),
  exit: motionEase(EXIT.ease),
};

function updateLayerLabels(group: VectorNode, alpha: number) {
  for (const node of descendants(group)) {
    if (node.hasClass('plane-label')) node.setAttribute('opacity', String(alpha));
  }
}

export function buildPlane(spec: Spec, root: VectorNode, beatTimesMs: number[]) {
  const [xLabel, yLabel] = spec.axes ?? copy.axes;
  const plot = chart(root, spec.x, spec.y, xLabel, yLabel, true, spec.scale !== 'independent');
  const schematic = spec.layers.some(layer =>
    ['construction', 'floor', 'snell'].includes(layer.type)
  );
  const axes = spec.grid !== false && (!schematic || spec.axes !== undefined);
  if (!axes)
    for (const node of plot.surface.children) {
      if (axisClasses.some(className => node.hasClass(className)))
        node.setAttribute('display', 'none');
    }

  const layerOrder = [...spec.layers].sort(
    (a, b) => Number(b.type === 'region') - Number(a.type === 'region')
  );
  const groups = new Map(
    layerOrder.map(layer => [layer.id, svg(plot.layers, 'g', { 'data-layer': layer.id })])
  );
  const draw = planeDrawing(spec, plot);
  const frames = parameterFrames(spec);
  const end = Number(root.data.durationMs) / 1000;
  const times = tracePlayback(
    root,
    spec.beats.length,
    beatTimesMs.map((ms, index) => ({ index, time: ms / 1000 })),
    end
  );
  const waveStates = spec.beats.map((_, i) =>
    spec.beats.slice(0, i + 1).reduce((state, beat) => beat.wave ?? state, false)
  );
  const visibility = spec.beats.map(
    (beat, i) =>
      beat.show ??
      spec.beats
        .slice(0, i)
        .reverse()
        .find(prior => prior.show)?.show ??
      layerOrder.map(layer => layer.id)
  );
  const floorMoves = new Map(
    spec.layers.flatMap(layer => {
      if (layer.type !== 'floor') return [];
      const start = visibility.findIndex(ids => ids.includes(layer.id));
      if (start < 0) return [];
      const count = layer.part === 'rays' ? layer.tiles + 1 : layer.rows;
      return [
        [
          layer.id,
          tracePlayback(root, count, [{ index: 0, time: times[start] }], times[start + 1] ?? end),
        ] as const,
      ];
    })
  );
  function opacity(id: string, index: number) {
    if (!visibility[index].includes(id)) return 0;
    return spec.beats[index].focus.includes(id) ? 1 : DIM;
  }
  const internalKeys = new Set(
    spec.layers.flatMap(layer =>
      layer.type === 'unit-circle-wave' && typeof layer.angle === 'string' ? [layer.angle] : []
    )
  );
  const labels = spec.beats.map(({ label, callout, focus }, index) => {
    if (label || !callout) return label;
    const layer = spec.layers.find(layer => layer.id === focus[0])!;
    switch (layer.type) {
      case 'tangent':
        return copy.tangent;
      case 'intersection':
        return copy.intersection;
      case 'roots':
        return copy.root;
      case 'grid-transform':
        return copy.basis;
      case 'construction':
        return layer.horizon ? copy.direction : layer.name;
      case 'floor':
        return copy.distance;
      case 'snell': {
        const value = (operand: number | string) =>
          typeof operand === 'number' ? operand : frames[index + 1][operand];
        const n1 = value(layer.n1),
          n2 = value(layer.n2);
        const { refraction } = snell(n1, n2, value(layer.angle));
        if (refraction === null) return copy.total;
        if (n2 > n1) return copy.toward;
        return n2 < n1 ? copy.away : layer.name;
      }
      default:
        return layer.name;
    }
  });
  const callouts = labels.map((label, i) => {
    if (!label) return undefined;
    const tag = pill(plot.surface, label, 'callout');
    markCalloutWindow(tag.group, times[i], times[i + 1] ?? Infinity);
    return tag;
  });
  let previousParams = '';
  let previousLabelLayout = '';
  const targets = new Map<string, Point>();

  function refreshDrawing(
    index: number,
    params: Record<string, number>,
    to: Record<string, number>,
    floorCounts: Map<string, number>
  ) {
    const fingerprint = JSON.stringify([index, params, [...floorCounts.values()]]);
    if (fingerprint === previousParams) return false;
    for (const item of layerOrder) {
      const group = groups.get(item.id)!;
      group.children.length = 0;
      let tracedAngle: number | undefined;
      if (item.type === 'unit-circle-wave' && waveStates[index]) {
        const angle = item.angle;
        const first = waveStates.lastIndexOf(false, index) + 1;
        tracedAngle =
          typeof angle === 'number'
            ? angle
            : Math.max(params[angle], ...frames.slice(first, index + 1).map(frame => frame[angle]));
      }
      targets.set(item.id, draw(group, item, params, to, tracedAngle, floorCounts.get(item.id)));
    }
    previousParams = fingerprint;
    return true;
  }

  function paintLayers(
    index: number,
    {
      focus,
      progress,
      elapsed,
      span,
    }: {
      focus: number;
      progress: (duration: number) => number;
      elapsed: number;
      span: number;
    }
  ) {
    const active = spec.beats[index];
    const visiblePaint = [];
    for (const [id, group] of groups) {
      const to = opacity(id, index),
        from = index === 0 ? to : opacity(id, index - 1);
      const t = from === 0 && to > 0 ? easing.arrive(progress(ARRIVE.duration)) : focus;
      const layerAlpha = mix(from, to, t);
      group.setAttribute('opacity', String(layerAlpha));
      const required = active.focus.includes(id) && to > 0;
      const previous = index === 0 || spec.beats[index - 1].focus.includes(id);
      const next = spec.beats[index + 1]?.focus.includes(id) ?? true;
      const departure = next
        ? 1
        : 1 - easing.exit(Math.max(0, (elapsed - span + EXIT.duration) / EXIT.duration));
      const arrival = previous ? 1 : focus;
      const labelAlpha = required ? arrival * departure : 0;
      updateLayerLabels(group, labelAlpha);
      if (layerAlpha > 0.01) visiblePaint.push([id, labelAlpha * layerAlpha > 0.01]);
    }
    return visiblePaint;
  }

  function seek(seconds: number, reduced?: boolean) {
    const index = times.reduce((last, time, at) => (seconds >= time ? at : last), 0);
    const from = frames[index],
      to = frames[index + 1];
    const elapsed = Math.max(0, seconds - times[index]);
    const span = (times[index + 1] ?? Infinity) - times[index];
    const progress = (duration: number) =>
      reduced ? 1 : Math.min(1, elapsed / Math.min(duration, span));
    const move = easing.move(progress(MOVE.duration));
    const focus = easing.focus(progress(FOCUS.duration));
    const sweepSpan = Math.min(span, Number(root.data.durationMs) / 1000 - times[index]);
    const sweep = waveStates[index] && sweepSpan > 0 ? progress(sweepSpan) : move;
    const params = Object.fromEntries(
      Object.keys(to).map(key => [
        key,
        mix(from[key], to[key], internalKeys.has(key) && to[key] > from[key] ? sweep : move),
      ])
    );
    const floorCounts = new Map(
      [...floorMoves].map(([id, starts]) => [
        id,
        starts.reduce((count, start) => count + Number(seconds >= start), 0),
      ])
    );
    const changedDrawing = refreshDrawing(index, params, to, floorCounts);
    const visiblePaint = paintLayers(index, { focus, progress, elapsed, span });
    const activeLabel = labels[index];
    for (const status of [...descendants(plot.surface)].filter(
      node => node.attrs['data-optics-status'] !== undefined
    )) {
      status.setAttribute(
        'display',
        status.attrs['data-optics-status'] === activeLabel ? 'none' : 'inline'
      );
    }
    // Lay out the diagram names before placing transient callouts against them.
    const layout = JSON.stringify([visiblePaint]);
    if (changedDrawing || layout !== previousLabelLayout) {
      previousLabelLayout = layout;
      placeDiagramLabels(
        plot.surface,
        root.viewport ? ['plane-label'] : ['plane-label', 'tick', 'axis-label'],
        { left: 5, top: 5, right: 995, bottom: 465 },
        (node, shape) =>
          node.parent === shape.parent && shape.attrs['data-plane-background'] !== undefined
      );
    }
    callouts.forEach((tag, at) => {
      if (!tag) return;
      if (at !== index || seconds < times[index]) {
        tag.group.setAttribute('display', 'none');
        return;
      }
      tag.group.removeAttribute('display');
      const exit = Math.min(EXIT.duration, span / 3);
      const arrival = easing.arrive(Math.min(1, elapsed / Math.min(ARRIVE.duration, span - exit)));
      const departure = easing.exit(Math.max(0, (elapsed - (span - exit)) / exit));
      tag.group.setAttribute('opacity', String(arrival * (1 - departure)));
      tag.group.y = (1 - arrival) * RISE;
      const target = targets.get(spec.beats[at].focus[0]);
      if (!target?.every(Number.isFinite)) return tag?.place([499, 235], [610, 170]);
      const cx = Math.min(box.right, Math.max(box.left, plot.x(target[0])));
      const cy = Math.min(box.bottom, Math.max(box.top, plot.y(target[1])));
      tag?.place([cx, cy], [cx + (cx > 780 ? -94 : 94), cy + (cy < 110 ? 53 : -61)]);
    });
  }
  return { cuts: new Set(times.flatMap(time => [time, time + MOVE.duration])), seek };
}
