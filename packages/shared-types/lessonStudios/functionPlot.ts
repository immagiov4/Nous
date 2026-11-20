import { line } from 'd3';
import * as z from 'zod';
import { plotArea as box, chart, derived, pill, placeTextAbove, textAt } from './chart';
import { studioViewportScale, WIDTH } from './chartDimensions';
import { functionPlotCopy as copy, formulaWords, titles } from './function-plot.copy.it';
import { checkAxisRange, geometryBeatFields } from './geometryStudioSpec';
import { MIN_TEXT_GAP_PX } from './layoutValidation';
import { ARRIVE, appear, DIM, EXIT, MOVE, timeline } from './motion';
import { motionEase } from './timeline';
import { type Point, svg, type VectorNode } from './vectorScene';

const STAGGER = 0.06;
const START_SCALE = 0.96;

export const functionPlotModelGuide = `function-plot spec {family,xRange:[min,max],yRange:[min,max],features?:[],keyframes:[{at,params}]}. Opposing axis endpoints in ascending order. Each keyframe params by family: linear {m,b}, quadratic {a,b,c} with a≠0, sine {amplitude,frequency,phase} with frequency>0 (radians), exponential {base,scale} with base>0. features: vertex (quadratic), roots (linear/quadratic), intercepts (y at x=0). Include only relevant features; optional Italian labels, e.g. {at:"b1",params:{a:-1,b:0,c:0}}. At least 1 keyframe and 2 endpoints per axis.`;

const range = z.tuple([z.number(), z.number()]);
const feature = z.enum(['vertex', 'roots', 'intercepts']);
// Round 1 records may contain note. Only the current label is rendered.
const keyframe = <T extends z.ZodType>(params: T) =>
  z
    .array(
      z.object({
        ...geometryBeatFields,
        params,
        note: z.string().min(1).regex(/\S/u).optional(),
      })
    )
    .min(1);
const axes = { xRange: range, yRange: range, features: z.array(feature).optional() };
export const FunctionPlotSpecSchema = z.discriminatedUnion('family', [
  z.object({
    ...axes,
    family: z.literal('linear'),
    keyframes: keyframe(z.object({ m: z.number(), b: z.number() })),
  }),
  z.object({
    ...axes,
    family: z.literal('quadratic'),
    keyframes: keyframe(
      z.object({
        a: z.number(),
        b: z.number(),
        c: z.number(),
      })
    ),
  }),
  z.object({
    ...axes,
    family: z.literal('sine'),
    keyframes: keyframe(
      z.object({
        amplitude: z.number(),
        frequency: z.number().positive(),
        phase: z.number(),
      })
    ),
  }),
  z.object({
    ...axes,
    family: z.literal('exponential'),
    keyframes: keyframe(z.object({ base: z.number().positive(), scale: z.number() })),
  }),
]);
type Spec = z.infer<typeof FunctionPlotSpecSchema>;
type FormatParameter = (key: string, value: number) => string;
type Marker = { id: string; x: number; y: number; label: string };
const SAMPLE_SPANS = 192;

function decimalPlaces(value: number) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  return Math.max(0, (mantissa.split('.')[1]?.length ?? 0) - Number(exponent));
}

function parameterFormatter(places: number) {
  const maxIntlPlaces = 100;
  const format = new Intl.NumberFormat('it-IT', {
    maximumFractionDigits: Math.min(places, maxIntlPlaces),
  });
  return (value: number) => {
    if (places <= maxIntlPlaces || decimalPlaces(value) <= maxIntlPlaces) {
      const text = format.format(value);
      return text === '-0' ? '0' : text;
    }
    // Keep subnormal coefficients readable when their precision exceeds Intl’s decimal limit.
    const [mantissa, exponent] = Math.abs(value).toExponential().split('e');
    const digits = '0'.repeat(-Number(exponent) - 1) + mantissa.replace('.', '');
    const kept = digits.slice(0, places);
    const rounded =
      Number(digits[places] ?? 0) >= 5
        ? (BigInt(kept) + 1n).toString().padStart(places, '0')
        : kept;
    const magnitude = Number('0.' + rounded);
    if (magnitude === 0) return '0';
    const sign = value < 0 ? '-' : '';
    return sign + magnitude.toExponential().replace('.', ',');
  };
}

function curve(family: Spec['family'], p: Record<string, number>) {
  const { a, b, c, m, amplitude, frequency, phase, base, scale } = p;
  if (family === 'linear') return (x: number) => m * x + b;
  if (family === 'quadratic') return (x: number) => (a * x + b) * x + c;
  if (family === 'sine') return (x: number) => amplitude * Math.sin(frequency * x + phase);
  return (x: number) => (scale === 0 ? 0 : scale * base ** x);
}

function featureRoots(family: Spec['family'], p: Record<string, number>) {
  const discriminant = p.b ** 2 - 4 * p.a * p.c;
  if (family === 'quadratic' && p.a !== 0 && discriminant >= 0) {
    if (discriminant === 0) return [-p.b / (2 * p.a)];
    const q = -(p.b + (p.b >= 0 ? 1 : -1) * Math.sqrt(discriminant)) / 2;
    const values = [q / p.a, p.c / q];
    values.sort((a, b) => a - b);
    return values;
  }
  const slope = family === 'linear' ? p.m : p.b;
  const offset = family === 'linear' ? p.b : p.c;
  return (family === 'linear' || p.a === 0) && slope !== 0 ? [-offset / slope] : [];
}

function featureLabelY(px: number, py: number, placed: { x: number; y: number }[]) {
  const direction = py < box.top + 68 ? 1 : -1;
  let labelY = py + direction * 30;
  while (placed.some(other => Math.abs(other.x - px) < 96 && Math.abs(other.y - labelY) < 27))
    labelY += direction * 28;
  return labelY;
}

function markers(spec: Spec, p: Record<string, number>, f: ReturnType<typeof curve>) {
  const points: Marker[] = [];
  if (spec.features?.includes('vertex') && p.a !== 0) {
    const x = -p.b / (2 * p.a);
    points.push({ id: 'vertex', x, y: f(x), label: copy.vertex });
  }
  if (spec.features?.includes('roots'))
    featureRoots(spec.family, p).forEach((x, i) =>
      points.push({ id: 'root-' + i, x, y: 0, label: copy.zero })
    );
  if (spec.features?.includes('intercepts'))
    points.push({ id: 'intercept', x: 0, y: f(0), label: copy.intercept });
  return points.filter(
    ({ x, y }, i) =>
      x >= spec.xRange[0] &&
      x <= spec.xRange[1] &&
      y >= spec.yRange[0] &&
      y <= spec.yRange[1] &&
      !points.slice(0, i).some(previous => previous.x === x && previous.y === y)
  );
}

function equation(family: Spec['family'], p: Record<string, number>, formatParam: FormatParameter) {
  const coefficient = (key: string) => formatParam(key, p[key]);
  const term = (key: string, variable = '') => {
    const value = formatParam(key, Math.abs(p[key]));
    if (value === '0') return '';
    const sign = p[key] < 0 ? formulaWords.subtraction : formulaWords.addition;
    return ' ' + sign + ' ' + value + variable;
  };
  if (family === 'quadratic')
    return formulaWords.value + coefficient('a') + formulaWords.square + term('b', 'x') + term('c');
  if (family === 'linear') return formulaWords.value + coefficient('m') + 'x' + term('b');
  if (family === 'sine')
    return (
      formulaWords.value +
      coefficient('amplitude') +
      formulaWords.sine +
      coefficient('frequency') +
      'x' +
      term('phase') +
      formulaWords.close
    );
  return (
    formulaWords.value +
    coefficient('scale') +
    formulaWords.product +
    coefficient('base') +
    formulaWords.exponent
  );
}

export function buildFunctionPlot(spec: Spec, root: VectorNode, beatTimesMs: number[]) {
  const { surface, layers, x, y, area } = chart(
    root,
    spec.xRange,
    spec.yRange,
    formulaWords.x,
    formulaWords.y,
    true
  );
  const ghost = svg(layers, 'path', { class: 'chart-line ghost', opacity: 0 });
  const stroke = svg(layers, 'path', { class: 'chart-line' });
  const equationChip = svg(surface, 'g', { class: 'parameter-chip' });
  const readout = svg(equationChip, 'rect', { y: 4, height: 40, rx: 20 });
  const parameter = textAt(equationChip, WIDTH - 57, 31, '', 'end', 'parameter');
  const formula = textAt(equationChip, WIDTH - 74, 28, '', 'end', 'equation');
  const readoutGap = root.viewport ? MIN_TEXT_GAP_PX / studioViewportScale(root.viewport) : 11;
  const featureLayer = svg(surface, 'g', {});
  const featureNodes = new Map(
    ['vertex', 'root-0', 'root-1', 'intercept'].map(id => {
      const axisLabel = id === 'intercept' ? copy.intercept : copy.zero;
      const label = id === 'vertex' ? copy.vertex : axisLabel;
      const tag = pill(featureLayer, label, 'feature-tag');
      const dot = svg(featureLayer, 'circle', { class: 'feature', r: 5 });
      const title = svg(dot, 'title', {});
      return [id, { tag, dot, title }];
    })
  );

  const domain = Array.from(
    { length: SAMPLE_SPANS + 1 },
    (_, i) => spec.xRange[0] + (spec.xRange[1] - spec.xRange[0]) * (i / SAMPLE_SPANS)
  );
  const path = line<Point>()
    .defined(point => Number.isFinite(point[1]))
    .x(point => x(point[0]))
    .y(point => point[1]);
  const paths = (f: ReturnType<typeof curve>) =>
    path(
      domain.map(value => {
        const ordinate = y(f(value));
        // Bound out-of-range coordinates before applying the plot's SVG clip.
        return [value, Math.min(box.bottom + 1000, Math.max(box.top - 1000, ordinate))];
      })
    ) ?? '';

  const frames: Record<string, number>[] = spec.keyframes.map(frame => frame.params);
  const keys = Object.keys(frames[0]);
  const readoutFormats = new Map(
    keys.map(key => {
      const places = Math.max(...frames.map(frame => decimalPlaces(frame[key])));
      return [key, parameterFormatter(places)];
    })
  );
  const formatParam: FormatParameter = (key, value) => readoutFormats.get(key)!(value);
  const features = (params: Record<string, number>) =>
    markers(spec, params, curve(spec.family, params));
  const keyframeFeatures = frames.map(
    params => new Map(features(params).map(marker => [marker.id, marker]))
  );
  const play = timeline();
  const end = Number(root.data.durationMs) / 1000;
  const calloutLayer = svg(surface, 'g', {});
  const notes = spec.keyframes.map(({ label }, i) => {
    if (!label) return;
    const callout = pill(calloutLayer, label, 'callout');
    appear(
      play,
      callout.group,
      beatTimesMs[i] / 1000,
      beatTimesMs[i + 1] === undefined ? Infinity : beatTimesMs[i + 1] / 1000
    );
    return callout;
  });

  function drawFeatures(
    params: Record<string, number>,
    { leftIndex, rightIndex, elapsed }: { leftIndex: number; rightIndex: number; elapsed: number }
  ) {
    const visible = new Map(features(params).map(marker => [marker.id, marker]));
    const placed: { x: number; y: number }[] = [];
    let birth = 0;
    for (const [id, { tag, dot, title }] of featureNodes) {
      const point = visible.get(id);
      const was = keyframeFeatures[leftIndex].get(id);
      const will = keyframeFeatures[rightIndex].get(id);
      const marker = point ?? was ?? will;
      let opacity = point ? 1 : 0;
      let scale = 1;
      if (!was && will) {
        const arrival = motionEase(ARRIVE.ease)(
          Math.max(0, Math.min(1, (elapsed - birth++ * STAGGER) / ARRIVE.duration))
        );
        opacity *= arrival;
        scale = START_SCALE + (1 - START_SCALE) * arrival;
      } else if (was && !will) {
        opacity = 1 - motionEase(EXIT.ease)(Math.min(1, elapsed / EXIT.duration));
      }
      for (const element of [dot, tag.group]) element.setAttribute('opacity', String(opacity));
      if (!marker || opacity === 0) continue;
      const px = x(marker.x),
        py = y(marker.y);
      dot.setAttribute('cx', String(px));
      dot.setAttribute('cy', String(py));
      dot.setAttribute('r', String(5 * scale));
      title.textContent = marker.label + ' (' + derived(marker.x) + ', ' + derived(marker.y) + ')';
      const labelY = featureLabelY(px, py, placed);
      tag.place([px, py], [px, labelY]);
      placed.push({ x: px, y: labelY });
    }
    return placed;
  }

  function render(leftIndex: number, rightIndex: number, progress: number, elapsed: number) {
    const left = frames[leftIndex];
    const right = frames[rightIndex];
    const params = Object.fromEntries(
      keys.map(key => [key, (1 - progress) * left[key] + progress * right[key]])
    );
    const f = curve(spec.family, params);
    stroke.setAttribute('d', paths(f));
    const changedKey = keys.find(key => left[key] !== right[key]) ?? keys[0];
    parameter.textContent = changedKey + ' = ' + formatParam(changedKey, params[changedKey]);
    const paramWidth = parameter.glyphs().advance;
    formula.textContent = equation(spec.family, params, formatParam);
    const chipWidth = paramWidth + 29;
    const chipLeft = WIDTH - 43 - chipWidth;
    formula.setAttribute('x', chipLeft - readoutGap);
    if (root.viewport) placeTextAbove(formula, area.top - 2 - readoutGap);
    readout.setAttribute('x', chipLeft);
    readout.setAttribute('width', String(chipWidth));

    const placed = drawFeatures(params, { leftIndex, rightIndex, elapsed });

    const callout = notes[rightIndex];
    if (!callout) return;
    // Pick the curve point nearest the upper-right callout while keeping its leader on the curve.
    const candidates = domain.flatMap(value => {
      const ordinate = f(value);
      return ordinate >= spec.yRange[0] && ordinate <= spec.yRange[1]
        ? [[x(value), y(ordinate)] as Point]
        : [];
    });
    const score = ([px, py]: Point) => Math.hypot(px - box.right * 0.74, py - (box.top + 90));
    const target = candidates.reduce<Point | undefined>(
      (best, point) => (!best || score(point) < score(best) ? point : best),
      undefined
    ) ?? [box.right - 100, box.top + 90];
    const side = target[0] + callout.width + 26 <= WIDTH ? 1 : -1;
    const calloutX = target[0] + side * (callout.width / 2 + 40);
    let calloutY = target[1] - 21;
    if (
      placed.some(
        other =>
          Math.abs(other.x - calloutX) < callout.width / 2 + 44 && Math.abs(other.y - calloutY) < 31
      )
    )
      calloutY -= 44;
    callout.place(target, [calloutX, Math.max(box.top + callout.height / 2, calloutY)]);
  }

  const beats = beatTimesMs.map(ms => ms / 1000);
  const fullFeatureArrival = ARRIVE.duration + 3 * STAGGER;
  let shownIndex = -1;
  let shownElapsed = -1;
  function drawAt(time: number, reduced?: boolean) {
    let index = beats.length - 1;
    while (index > 0 && beats[index] > time) index--;
    const start = beats[index],
      space = (beats[index + 1] ?? end) - start;
    const elapsed =
      index === 0 || reduced
        ? fullFeatureArrival
        : Math.min(time - start, space, Math.max(fullFeatureArrival, MOVE.duration));
    if (index === shownIndex && elapsed === shownElapsed) return;
    if (index !== shownIndex) {
      ghost.setAttribute('d', index ? paths(curve(spec.family, frames[index - 1])) : '');
      ghost.setAttribute('opacity', String(index ? DIM : 0));
    }
    shownIndex = index;
    shownElapsed = elapsed;
    const previous = Math.max(0, index - 1);
    const progress =
      index === 0
        ? 1
        : motionEase(MOVE.ease)(Math.min(1, elapsed / Math.min(MOVE.duration, space)));
    render(previous, index, progress, elapsed);
  }
  return {
    cuts: new Set([
      ...play.cuts,
      ...beats.flatMap(time => [time, time + MOVE.duration, time + fullFeatureArrival]),
    ]),
    seek(seconds: number, reduced?: boolean) {
      play.seek(seconds, reduced);
      drawAt(seconds, reduced);
    },
  };
}

export const functionPlotTitle = (spec: Spec) => titles[spec.family];

export function checkFunctionPlotSpec(spec: Spec) {
  checkAxisRange(spec.xRange);
  checkAxisRange(spec.yRange);
  if (spec.family === 'quadratic' && spec.keyframes.some(frame => frame.params.a === 0)) {
    throw new Error('Quadratic coefficients require nonzero a');
  }
  for (const feature of spec.features ?? []) {
    if (feature === 'vertex' && spec.family !== 'quadratic')
      throw new Error('Vertex requires a quadratic function');
    if (feature === 'roots' && spec.family !== 'quadratic' && spec.family !== 'linear')
      throw new Error('Roots require a linear or quadratic function');
  }
}
