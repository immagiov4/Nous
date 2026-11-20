import { plotArea as box, type chart, derived, derivedFormatter, textAt } from './chart';
import { planeCopy as copy, optics } from './plane.copy.it';
import { compile, mix, roots, sample, snell } from './planeMath';
import type { Layer, Parameters, PointRef, Scalar, Spec } from './planeSpec';
import type { StudioAnchor } from './studioTypography';
import { type Point, svg, type VectorNode } from './vectorScene';

const COLORS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-0)'];
const INK = 'var(--ink)';
const ACCENT = 'var(--accent)';
type Chart = ReturnType<typeof chart>;
type Graph = { value(x: number): number; vertical?: number };
type OpticalLayer = Extract<Layer, { type: 'snell' }>;

function mediumName(media: OpticalLayer['media'], index: number, fallback: string) {
  if (!media) return fallback;
  return media.reduce(
    (nearest, candidate) =>
      Math.abs(candidate.index - index) < Math.abs(nearest.index - index) ? candidate : nearest,
    media[0]
  ).name;
}

const reflectance = (a: number, b: number) => (a + b > 0 ? ((a - b) / (a + b)) ** 2 : 1);

function interpolatePoint([x1, y1]: Point, [x2, y2]: Point, progress: number): Point {
  return [mix(x1, x2, progress), mix(y1, y2, progress)];
}
const slopeStep = (x: number) => Math.cbrt(Number.EPSILON) * Math.max(1, Math.abs(x));
function slopeAt(f: Graph['value'], x: number, h: number) {
  const step = slopeStep(x);
  return Math.abs(h) <= step ? (f(x + step) - f(x - step)) / (2 * step) : (f(x + h) - f(x)) / h;
}

function* matchingRuns(domain: number[], matches: (at: number) => boolean) {
  let run: number[] = [];
  for (const at of domain) {
    if (matches(at)) {
      run.push(at);
    } else {
      if (run.length > 1) yield run;
      run = [];
    }
  }
  if (run.length > 1) yield run;
}

function* regionSpans(
  domain: number[],
  difference: Graph['value'],
  shaded: (difference: number) => boolean
) {
  for (const run of matchingRuns(domain, at => Number.isFinite(difference(at)))) {
    const first = run[0],
      last = run[run.length - 1];
    const crossings = new Set(roots(difference, run));
    const bounds = [first, ...[...crossings].filter(at => first < at && at < last), last];
    for (const [i, start] of bounds.slice(0, -1).entries()) {
      const end = bounds[i + 1];
      const samples = [start, ...run.filter(at => start < at && at < end), end];
      // A discontinuity can change which curve is above without producing an intersection.
      yield* matchingRuns(samples, at => crossings.has(at) || shaded(difference(at)));
    }
  }
}

function gridCoordinates(start: number, end: number, step: number) {
  const count = Math.floor((end - start) / step) + 1;
  // Count lattice steps at the origin, where adding one is always representable.
  return new Set(Array.from({ length: count }, (_, i) => start + i * step));
}

export function planeDrawing(spec: Spec, plot: Chart) {
  const { x, y } = plot;
  const domain = sample(spec.x);
  const mid = (spec.x[0] + spec.x[1]) / 2;
  const xs = (v: number) => Math.max(box.left - 1000, Math.min(box.right + 1000, x(v)));
  const ys = (v: number) => Math.max(box.top - 1000, Math.min(box.bottom + 1000, y(v)));
  const px = ([a, b]: Point): Point => [xs(a), ys(b)];
  const inside = ([a, b]: Point) =>
    a >= spec.x[0] && a <= spec.x[1] && b >= spec.y[0] && b <= spec.y[1];
  const lookup = new Map(spec.layers.map(layer => [layer.id, layer]));
  const compiled = new Map(
    spec.layers.flatMap(layer =>
      layer.type === 'curve'
        ? [[layer.id, compile(layer.expr, Object.keys(spec.parameters ?? {}))] as const]
        : []
    )
  );
  const strokeColors = new Map(
    spec.layers
      .filter(item => item.type === 'line' || item.type === 'curve')
      .map((item, index) => [item.id, COLORS[index % COLORS.length]])
  );
  return (
    group: VectorNode,
    layer: Layer,
    params: Parameters,
    final: Parameters,
    tracedAngle?: number,
    floorSteps?: number
  ): Point => {
    const value = (input: Scalar) => (typeof input === 'number' ? input : params[input]);
    const destination = (input: Scalar) => (typeof input === 'number' ? input : final[input]);
    const point = (input: PointRef): Point => {
      const coordinates =
        typeof input === 'string'
          ? (lookup.get(input) as Extract<Layer, { type: 'point' }>).at
          : input;
      return [value(coordinates[0]), value(coordinates[1])];
    };
    const graph = (id: string, parameters = params): Graph => {
      const item = lookup.get(id) as Extract<Layer, { type: 'curve' | 'line' }>;
      if (item.type === 'curve') return { value: x => compiled.get(id)!(x, parameters) };
      if (!Array.isArray(item.form)) {
        const { m, b } = item.form;
        const coefficient = (input: Scalar) =>
          typeof input === 'number' ? input : parameters[input];
        return { value: x => coefficient(m) * x + coefficient(b) };
      }
      const [[ax, ay], [bx, by]] = item.form.map(point);
      if (ax === bx) return { value: () => NaN, ...(ay !== by ? { vertical: ax } : {}) };
      return { value: x => ay + ((by - ay) * (x - ax)) / (bx - ax) };
    };
    const path = (d: string, color = ACCENT, width = 3, fill = 'none', opacity = 1, dash = '') =>
      svg(group, 'path', {
        d,
        stroke: color,
        'stroke-width': width,
        fill,
        opacity,
        'stroke-dasharray': dash,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
    const polyline = (points: Point[], color = ACCENT, width = 3, dash = '') => {
      const painted = path(
        points.map((p, i) => (i ? 'L' : 'M') + px(p).join(' ')).join(' '),
        color,
        width,
        'none',
        1,
        dash
      );
      if (points.length === 3) {
        const [[ax, ay], [bx, by], [cx, cy]] = points;
        const u = [ax - bx, ay - by],
          v = [cx - bx, cy - by];
        const size = Math.hypot(...u) * Math.hypot(...v);
        if (size && Math.abs(u[0] * v[0] + u[1] * v[1]) < size * 1e-8) {
          painted.setAttribute('data-geometry-right-angle', '');
        }
      }
      return painted;
    };
    const arrow = (from: Point, to: Point, color: string, opacity = 1) => {
      const first = group.children.length;
      const [ax, ay] = px(from),
        [bx, by] = px(to);
      const angle = Math.atan2(by - ay, bx - ax);
      if (ax === bx && ay === by) return;
      polyline([from, to], color, 3.8);
      const wing = (turn: number) =>
        [bx - 13 * Math.cos(angle + turn), by - 13 * Math.sin(angle + turn)].join(' ');
      path('M' + wing(0.45) + ' L' + [bx, by].join(' ') + ' L' + wing(-0.45), color, 3.8);
      for (const stroke of Array.from(group.children).slice(first))
        stroke.setAttribute('opacity', String(opacity));
    };
    const label = (p: Point, content: string, color = INK, side: StudioAnchor = 'start') => {
      const [atX, atY] = px(p);
      const node = textAt(group, atX, atY, content, side, 'plane-label');
      node.setAttribute('style', 'fill:' + color);
      const { left, right } = node.glyphs().bounds;
      const shift =
        Math.max(0, box.left + 8 - (atX + left)) - Math.max(0, atX + right - box.right + 8);
      node.setAttribute('x', String(atX + shift));
      node.setAttribute('y', String(Math.max(box.top + 18, Math.min(box.bottom - 5, atY))));
    };
    const mark = (p: Point, name = '', color = ACCENT) => {
      if (!inside(p)) return;
      const [cx, cy] = px(p);
      svg(group, 'circle', {
        cx,
        cy,
        r: 6,
        stroke: color,
        'stroke-width': 3,
        fill: 'var(--surface)',
      });
      if (name) label([x.invert(cx + 13), y.invert(cy - 12)], name);
    };
    const drawGraph = (f: Graph, color: string, customDomain = domain) => {
      if (f.vertical !== undefined) {
        polyline(
          [
            [f.vertical, spec.y[0]],
            [f.vertical, spec.y[1]],
          ],
          color,
          4
        );
        return [f.vertical, (spec.y[0] + spec.y[1]) / 2] as Point;
      }
      let previous: number | undefined;
      const d = customDomain
        .map(a => {
          const b = f.value(a);
          const ordinate = ys(b);
          const starts =
            previous === undefined || Math.abs(previous - ordinate) > box.bottom - box.top;
          previous = Number.isFinite(b) ? ordinate : undefined;
          if (previous === undefined) return '';
          return (starts ? 'M' : 'L') + [xs(a), ordinate].join(' ');
        })
        .join(' ');
      path(d, color, 4);
      return (
        customDomain
          .map(a => [a, f.value(a)] as Point)
          .filter(inside)
          .reverse()
          .find(p => y(p[1]) > box.top + 27 && x(p[0]) < box.right - 26) ??
        ([mid, f.value(mid)] as Point)
      );
    };
    const features = (points: Point[], name?: string): Point => {
      const visible = points.filter(inside);
      for (const p of visible)
        mark(p, (name ? name + ' ' : '') + '(' + p.map(derived).join('; ') + ')');
      return visible[0] ?? [mid, (spec.y[0] + spec.y[1]) / 2];
    };

    const circle = (center: Point, radius: number, color: string) =>
      svg(group, 'ellipse', {
        cx: x(center[0]),
        cy: y(center[1]),
        rx: Math.abs(x(center[0] + radius) - x(center[0])),
        ry: Math.abs(y(center[1] + radius) - y(center[1])),
        fill: 'none',
        stroke: color,
        'stroke-width': 3,
        'data-geometry-circle': '',
      });
    function drawCircle(layer: Extract<Layer, { type: 'circle' }>): Point {
      const center = point(layer.center);
      circle(center, layer.radius, COLORS[0]);
      const top: Point = [center[0], center[1] + layer.radius];
      if (layer.name) label(top, layer.name);
      return top;
    }

    function drawUnitCircleWave(layer: Extract<Layer, { type: 'unit-circle-wave' }>): Point {
      const wave = tracedAngle !== undefined;
      const theta = (value(layer.angle) * Math.PI) / 180;
      const p: Point = [Math.cos(theta), Math.sin(theta)];
      circle([0, 0], 1, COLORS[0]);
      polyline(
        [
          [-1, 0],
          [1, 0],
        ],
        'var(--rule)',
        1.6
      );
      polyline(
        [
          [0, -1],
          [0, 1],
        ],
        'var(--rule)',
        1.6
      );
      polyline([[0, 0], p], ACCENT, 3.2);
      const anglePath = Array.from(
        { length: 33 },
        (_, i): Point => [0.24 * Math.cos((theta * i) / 32), 0.24 * Math.sin((theta * i) / 32)]
      );
      if (theta && !wave) polyline(anglePath, ACCENT, 2);
      const projection: Point = [p[0], 0];
      polyline([[0, 0], projection], COLORS[2], 4);
      polyline([projection, p], COLORS[1], 4);
      if (Math.abs(p[1]) > 1e-6 && Math.abs(p[0]) > 1e-6) {
        const stepX = -Math.sign(p[0]) * Math.min(0.1, Math.abs(p[0]) / 2);
        const stepY = Math.sign(p[1]) * Math.min(0.1, Math.abs(p[1]) / 2);
        polyline(
          [
            [p[0] + stepX, 0],
            [p[0] + stepX, stepY],
            [p[0], stepY],
          ],
          COLORS[1],
          1.6
        );
      }
      mark(p, 'P');
      if (!wave && layer.cosineName && Math.abs(p[0]) > 0.1)
        label([p[0] / 2, -0.18], layer.cosineName);
      if (!wave && layer.sineName && Math.abs(p[1]) > 0.1) label([p[0], p[1] / 2], layer.sineName);
      if (wave) {
        const start = layer.waveStart,
          end = start + 2 * Math.PI;
        const turn = 2 * Math.PI;
        const wrapped = ((theta % turn) + turn) % turn;
        const angle = theta > 0 && wrapped < 1e-10 ? turn : wrapped;
        const traceEnd = Math.min(turn, Math.max(0, (tracedAngle! * Math.PI) / 180));
        const wavePoint: Point = [start + angle, p[1]];
        polyline(
          [
            [start, 0],
            [end, 0],
          ],
          'var(--rule)',
          2
        );
        polyline(
          [
            [start, -1],
            [start, 1],
          ],
          'var(--rule)',
          2
        );
        polyline([p, wavePoint], COLORS[1], 2, '5 6');
        if (traceEnd > 0)
          polyline(
            Array.from(
              { length: 97 },
              (_, i): Point => [start + (traceEnd * i) / 96, Math.sin((traceEnd * i) / 96)]
            ),
            COLORS[1],
            4
          );
        mark(wavePoint, '', COLORS[1]);
      }
      return p;
    }

    function drawCurveOrLine(layer: Extract<Layer, { type: 'line' | 'curve' }>): Point {
      const color = strokeColors.get(layer.id)!;
      const p = drawGraph(graph(layer.id), color);
      if (layer.name)
        label([x.invert(x(p[0]) - 8), y.invert(y(p[1]) - 13)], layer.name, INK, 'end');
      return p;
    }

    function drawPoint(layer: Extract<Layer, { type: 'point' }>): Point {
      const p = point(layer.at);
      mark(p, layer.name);
      return p;
    }

    function drawLinearConstruction(
      layer: Extract<Layer, { type: 'segment' | 'vector' | 'construction' }>
    ): Point {
      const [a, b] = layer.through.map(point);
      let end = b;
      let points: Point[] | undefined;
      if (layer.type === 'construction') {
        if (layer.horizon !== undefined && a[1] !== b[1]) {
          const horizon = value(layer.horizon);
          end = [a[0] + ((b[0] - a[0]) * (horizon - a[1])) / (b[1] - a[1]), horizon];
        } else if (layer.horizon === undefined && a[0] !== b[0]) {
          const f = (at: number) => a[1] + ((at - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
          points = spec.x.map(at => [at, f(at)]);
        } else if (layer.horizon === undefined && a[1] !== b[1]) {
          points = spec.y.map(at => [a[0], at]);
        }
      }
      if (layer.type === 'vector') arrow(a, end, ACCENT);
      else
        polyline(
          points ?? [a, end],
          COLORS[0],
          2.6,
          layer.type === 'segment' && !layer.name ? '7 6' : ''
        );
      if (layer.name)
        label([mix(a[0], end[0], 0.72), y.invert(y(mix(a[1], end[1], 0.72)) - 10)], layer.name);
      return end;
    }

    function drawRegion(layer: Extract<Layer, { type: 'region' }>): Point {
      const top = graph(layer.between[0]).value,
        bottom = graph(layer.between[1]).value;
      const difference = (at: number) => top(at) - bottom(at);
      const shaded =
        layer.where === 'above' ? (delta: number) => delta > 0 : (delta: number) => delta < 0;
      let target: Point = [mid, NaN];
      for (const values of regionSpans(domain, difference, shaded)) {
        const center = mix(values[0], values[values.length - 1], 0.5);
        const delta = difference(center);
        if (!Number.isFinite(delta) || !shaded(delta)) continue;
        const polygon = [
          ...values.map(at => [at, top(at)] as Point),
          ...[...values].reverse().map(at => [at, bottom(at)] as Point),
        ];
        if (!polygon.every(p => Number.isFinite(p[1]))) continue;
        const color = layer.where === 'above' ? COLORS[3] : COLORS[1];
        path(`M${polygon.map(p => px(p).join(' ')).join(' L')}Z`, 'none', 0, color, 0.29);
        const topEdge = Math.min(spec.y[1], Math.max(top(center), bottom(center)));
        const bottomEdge = Math.max(spec.y[0], Math.min(top(center), bottom(center)));
        if (topEdge < bottomEdge) continue;
        target = [center, (topEdge + bottomEdge) / 2];
        if (layer.name) label(target, layer.name, INK, 'middle');
      }
      return target;
    }

    function drawIntersection(layer: Extract<Layer, { type: 'intersection' }>): Point {
      const name = layer.name
        ?.replaceAll(/\(\s*[+\-−]?\d[\d.,\s]*[,;]\s*[+\-−]?\d[\d.,\s]*\)/gu, '')
        .trim();
      const [a, b] = layer.of.map(id => graph(id));
      if (a.vertical !== undefined && b.vertical !== undefined) return features([]);
      const vertical = a.vertical ?? b.vertical;
      if (vertical !== undefined)
        return features([[vertical, (a.vertical !== undefined ? b : a).value(vertical)]], name);
      return features(
        roots(at => a.value(at) - b.value(at), domain).map(at => [at, a.value(at)]),
        name
      );
    }

    function drawRoots(layer: Extract<Layer, { type: 'roots' }>): Point {
      return features(
        roots(graph(layer.of).value, domain).map(at => [at, 0]),
        layer.name
      );
    }

    function drawTangent(layer: Extract<Layer, { type: 'tangent' }>): Point {
      const f = graph(layer.of).value;
      const a = value(layer.x),
        h = value(layer.h),
        b = a + h,
        fa = f(a),
        fb = f(b);
      const step = slopeStep(a);
      const slope = slopeAt(f, a, h);
      if (!Number.isFinite(slope)) return [a, fa];
      drawGraph({ value: at => fa + slope * (at - a) }, ACCENT);
      if (Math.abs(h) > step) {
        polyline(
          [
            [a, fa],
            [b, fa],
            [b, fb],
          ],
          COLORS[2],
          2,
          '5 5'
        );
        mark([b, fb], '', COLORS[0]);
      }
      mark([a, fa]);
      label(
        [x.invert(x(a) - 28), y.invert(y(fa) - 25)],
        copy.slope +
          derivedFormatter(
            slopeAt(graph(layer.of, final).value, destination(layer.x), destination(layer.h))
          )(slope),
        INK,
        'end'
      );
      return [a, fa];
    }

    function drawGridTransform(layer: Extract<Layer, { type: 'grid-transform' }>): Point {
      const [[a, b], [c, d]] = layer.matrix.map(row => row.map(value));
      const t = ([u, v]: Point): Point => [a * u + b * v, c * u + d * v];
      const xmin = Math.floor(spec.x[0]),
        xmax = Math.ceil(spec.x[1]);
      const ymin = Math.floor(spec.y[0]),
        ymax = Math.ceil(spec.y[1]);
      const gridStep = Math.max(1, Math.ceil(Math.max(xmax - xmin, ymax - ymin) / 24));
      const gridLine = (from: Point, to: Point) => {
        let start = 0,
          end = 1;
        for (const [i, [min, max]] of [spec.x, spec.y].entries()) {
          const delta = to[i] - from[i];
          if (!delta) {
            if (from[i] < min || from[i] > max) return;
            continue;
          }
          const a = (min - from[i]) / delta,
            b = (max - from[i]) / delta;
          start = Math.max(start, Math.min(a, b));
          end = Math.min(end, Math.max(a, b));
        }
        if (start <= end)
          polyline(
            [interpolatePoint(from, to, start), interpolatePoint(from, to, end)],
            'var(--rule)',
            1
          );
      };
      for (const u of gridCoordinates(xmin, xmax, gridStep)) gridLine(t([u, ymin]), t([u, ymax]));
      for (const v of gridCoordinates(ymin, ymax, gridStep)) gridLine(t([xmin, v]), t([xmax, v]));
      const square: Point[] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      path(
        'M' + square.map(p => px(t(p)).join(' ')).join(' L') + 'Z',
        COLORS[0],
        2,
        'color-mix(in srgb, var(--chart-1) 24%, transparent)'
      );
      arrow([0, 0], t([1, 0]), ACCENT);
      arrow([0, 0], t([0, 1]), COLORS[0]);
      const i = t([1, 0]),
        j = t([0, 1]);
      label([x.invert(x(i[0]) + 9), y.invert(y(i[1]) + 19)], optics.basisI);
      label([x.invert(x(j[0]) - 12), y.invert(y(j[1]) - 11)], optics.basisJ, INK, 'end');
      const area = Math.abs(a * d - b * c);
      const [[endA, endB], [endC, endD]] = layer.matrix.map(row => row.map(destination));
      const display = derivedFormatter(Math.abs(endA * endD - endB * endC));
      const center = t([0.52, 0.52]);
      label(
        [center[0], y.invert(y(center[1]) - 35 * Math.max(0, 1 - area / 0.2))],
        copy.area + display(area),
        INK,
        'middle'
      );
      return t([1, 1]);
    }

    function drawFloor(layer: Extract<Layer, { type: 'floor' }>): Point {
      const vp = point(layer.vanishing);
      const [a, b] = layer.near.map(point);
      const vertices = Array.from(
        { length: layer.tiles + 1 },
        (_, i): Point => [mix(a[0], b[0], i / layer.tiles), mix(a[1], b[1], i / layer.tiles)]
      );
      // Equal steps on a ground plane project at inverse depth in a pinhole view.
      const row = (p: Point, index: number): Point => [
        mix(vp[0], p[0], 1 / (1 + index * 0.36)),
        mix(vp[1], p[1], 1 / (1 + index * 0.36)),
      ];
      if (layer.part === 'rays') {
        for (const corner of vertices.slice(0, floorSteps ?? vertices.length))
          polyline([corner, vp], COLORS[0], 2.6);
        return vp;
      }
      const rows = floorSteps ?? layer.rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < layer.tiles; c++) {
          if ((r + c) % 2) continue;
          const polygon = [
            row(vertices[c], r),
            row(vertices[c + 1], r),
            row(vertices[c + 1], r + 1),
            row(vertices[c], r + 1),
          ];
          path('M' + polygon.map(p => px(p).join(' ')).join(' L') + 'Z', 'none', 0, COLORS[0], 0.2);
        }
        polyline([row(a, r), row(b, r)], COLORS[0], 1.6);
      }
      polyline([row(a, rows), row(b, rows)], COLORS[0], 1.6);
      return row(vertices[Math.floor(layer.tiles / 2)], 2);
    }

    function drawSnell(layer: OpticalLayer): Point {
      const n1 = value(layer.n1),
        n2 = value(layer.n2),
        angle = value(layer.angle);
      const { refraction, critical } = snell(n1, n2, angle);
      const cy = (spec.y[0] + spec.y[1]) / 2;
      const origin: Point = [mid, cy];
      const halfHeight = (box.bottom - box.top) * 0.37;
      const halfWidth = (box.right - box.left) * 0.35;
      const pointAt = (theta: number, side: number, down: number, length: number): Point => {
        const radians = (theta * Math.PI) / 180;
        return [
          x.invert(x(mid) + side * Math.sin(radians) * length),
          y.invert(y(cy) + down * Math.cos(radians) * length),
        ];
      };
      const len = Math.min(halfHeight, halfWidth);
      const interfaceY = y(cy);
      const shadeTop = n1 > n2 ? box.top : interfaceY;
      svg(group, 'rect', {
        x: box.left,
        y: shadeTop,
        width: box.right - box.left,
        'data-plane-background': '',
        height: (n1 > n2 ? interfaceY : box.bottom) - shadeTop,
        fill: COLORS[0],
        opacity: n1 === n2 ? 0 : 0.13,
      });
      polyline(
        [
          [spec.x[0], cy],
          [spec.x[1], cy],
        ],
        COLORS[0],
        2
      );
      polyline(
        [
          [mid, spec.y[0]],
          [mid, spec.y[1]],
        ],
        'var(--rule)',
        2,
        '7 6'
      );
      label(
        [x.invert(box.left + 23), y.invert(y(cy) - 36)],
        mediumName(layer.media, n1, copy.medium1) + optics.index1 + derived(n1)
      );
      label(
        [x.invert(box.left + 23), y.invert(y(cy) + 54)],
        mediumName(layer.media, n2, copy.medium2) + optics.index2 + derived(n2)
      );
      arrow(pointAt(angle, -1, -1, len), origin, ACCENT);
      const incidentCos = Math.cos((angle * Math.PI) / 180);
      const exitCos = refraction === null ? 0 : Math.cos((refraction * Math.PI) / 180);
      const reflected =
        (reflectance(n1 * incidentCos, n2 * exitCos) +
          reflectance(n2 * incidentCos, n1 * exitCos)) /
        2;
      if (refraction !== null) arrow(origin, pointAt(refraction, 1, 1, len), ACCENT, 1 - reflected);
      if (reflected > 0) arrow(origin, pointAt(angle, 1, -1, len), ACCENT, reflected);
      const angleArc = (theta: number, side: number, down: number, radius: number) => {
        if (theta === 0) return;
        path(
          'M' +
            px(pointAt(0, side, down, radius)).join(' ') +
            ' A' +
            radius +
            ' ' +
            radius +
            ' 0 0 ' +
            (side === down ? 0 : 1) +
            ' ' +
            px(pointAt(theta, side, down, radius)).join(' '),
          ACCENT,
          1.5
        );
      };
      angleArc(angle, -1, -1, 55);
      if (refraction !== null) angleArc(refraction, 1, 1, 55);
      label(
        [x.invert(x(mid) - 110), y.invert(y(cy) - 99)],
        optics.angle1 + derivedFormatter(destination(layer.angle))(angle) + optics.angleUnit,
        INK,
        'end'
      );
      const finalAngles = snell(
        destination(layer.n1),
        destination(layer.n2),
        destination(layer.angle)
      );
      const outLabel =
        refraction === null
          ? copy.total
          : optics.angle2 +
            derivedFormatter(finalAngles.refraction ?? refraction)(refraction) +
            optics.angleUnit;
      label([x.invert(x(mid) + 126), y.invert(y(cy) + (refraction === null ? -80 : 82))], outLabel);
      if (refraction === null)
        group.children[group.children.length - 1].setAttribute('data-optics-status', outLabel);
      if (critical !== null)
        label(
          [x.invert(box.right - 22), y.invert(y(cy) + (n1 > n2 ? -140 : 147))],
          optics.critical +
            derivedFormatter(finalAngles.critical ?? critical)(critical) +
            optics.angleUnit,
          INK,
          'end'
        );
      return origin;
    }

    switch (layer.type) {
      case 'circle':
        return drawCircle(layer);
      case 'unit-circle-wave':
        return drawUnitCircleWave(layer);
      case 'line':
      case 'curve':
        return drawCurveOrLine(layer);
      case 'point':
        return drawPoint(layer);
      case 'segment':
      case 'vector':
      case 'construction':
        return drawLinearConstruction(layer);
      case 'region':
        return drawRegion(layer);
      case 'intersection':
        return drawIntersection(layer);
      case 'roots':
        return drawRoots(layer);
      case 'tangent':
        return drawTangent(layer);
      case 'grid-transform':
        return drawGridTransform(layer);
      case 'floor':
        return drawFloor(layer);
      case 'snell':
        return drawSnell(layer);
    }
  };
}
