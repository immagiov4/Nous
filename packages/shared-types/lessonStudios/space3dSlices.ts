import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { copy, sliceDimensions, slicePercent } from './space3dCopy.it';
import type { Palette } from './space3dDraw';
import { lines, moveVertices, polyline } from './space3dDraw';
import { overlayMark as svg, textAt } from './space3dOverlay';
import type { Beat, Spec } from './space3dSpec';
import type { VectorNode } from './vectorScene';

const segments = 64;
const subdivisions = [4, 8, 32] as const;
const percent = new Intl.NumberFormat('it-IT', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function liquidLevels(cones: number, inTransfer: number) {
  // The missing tip is a similar cone: its volume scales with the cube of its height.
  return { cylinder: cones / 3, cone: 1 - Math.cbrt(inTransfer) };
}

export function midpointAreas(n: number) {
  return Array.from({ length: n }, (_, i) => (1 - (i + 0.5) / n) ** 2);
}

function areaChart(overlay: VectorNode, colors: Palette, ratio: number) {
  const panel = svg(overlay, 'g', {});
  panel.x = 622;
  panel.y = 34;
  const width = 306,
    height = 143,
    baseline = 326;
  const ink = colors.ink.getStyle(),
    tank = colors.accent.getStyle(),
    cone = colors.far.getStyle();
  const diskRadius = Math.min(44, 110 * ratio);
  const disks = [tank, cone].map((fill, i) => {
    const x = 77 + i * 152;
    textAt(panel, x, 25, i ? copy.cone : copy.cylinder, 'middle', 'axis-label');
    return svg(panel, 'ellipse', {
      cx: x,
      cy: 88,
      rx: diskRadius,
      ry: diskRadius,
      fill,
      'fill-opacity': 0.36,
      stroke: fill,
      'stroke-width': 2,
    });
  });
  textAt(panel, 0, baseline - height - 16, copy.sliceArea, 'start', 'axis-label');
  textAt(panel, 0, baseline + 20, copy.base, 'start', 'axis-label');
  textAt(panel, width / 2, baseline + 20, copy.height, 'middle', 'axis-label');
  textAt(panel, width, baseline + 32, copy.apex, 'end', 'axis-label');
  svg(panel, 'path', {
    d: `M0 ${baseline - height}V${baseline}H${width}`,
    fill: 'none',
    stroke: ink,
    opacity: 0.45,
  });
  const rectangle = svg(panel, 'rect', {
    x: 0,
    y: baseline - height,
    width: 0,
    height,
    fill: tank,
    'fill-opacity': 0.13,
    stroke: tank,
    'stroke-opacity': 0.65,
  });
  const parabola = svg(panel, 'path', {
    fill: cone,
    'fill-opacity': 0.25,
    stroke: cone,
    'stroke-width': 2,
  });
  const cursor = svg(panel, 'line', {
    y1: baseline - height,
    y2: baseline,
    stroke: ink,
    'stroke-dasharray': '4 4',
    opacity: 0.55,
  });
  const point = svg(panel, 'circle', { r: 4, fill: cone });
  const bars = new Map(
    subdivisions.map(n => {
      const cells = midpointAreas(n);
      const group = svg(panel, 'g', {});
      cells.forEach((area, i) =>
        svg(group, 'rect', {
          x: (i * width) / n,
          y: baseline - area * height,
          width: width / n,
          height: area * height,
          fill: cone,
          'fill-opacity': 0.42,
          stroke: cone,
          'stroke-width': 0.75,
        })
      );
      return [n, { group, total: cells.reduce((a, b) => a + b, 0) / n }] as const;
    })
  );
  const comparison = svg(panel, 'g', {});
  comparison.y = 369;
  svg(comparison, 'rect', { width, height: 10, fill: tank, 'fill-opacity': 0.14, stroke: tank });
  const share = svg(comparison, 'rect', { height: 10, fill: cone });
  for (const third of [1, 2])
    svg(comparison, 'line', {
      x1: (width * third) / 3,
      x2: (width * third) / 3,
      y1: -4,
      y2: 14,
      stroke: ink,
      'stroke-opacity': 0.7,
    });
  const result = textAt(comparison, width, 33, '', 'end', 'axis-label');

  return (z: number, count: Beat['bars'], strength: number) => {
    panel.setAttribute('opacity', String(strength));

    disks.forEach((disk, i) => {
      const radius = diskRadius * (i ? 1 - z : 1);
      disk.setAttribute('rx', String(radius));
      disk.setAttribute('ry', String(radius));
    });
    const x = z * width,
      y = baseline - height * (1 - z) ** 2;
    rectangle.setAttribute('width', String(x));
    // A quadratic Bézier exactly represents the parabola on the interval already swept.
    parabola.setAttribute(
      'd',
      `M0 ${baseline - height}Q${x / 2} ${baseline - height + height * z} ${x} ${y}V${baseline}H0Z`
    );
    for (const attr of ['x1', 'x2']) cursor.setAttribute(attr, String(x));
    point.setAttribute('cx', String(x));
    point.setAttribute('cy', String(y));
    for (const [n, { group }] of bars)
      group.setAttribute('visibility', n === count ? 'visible' : 'hidden');
    parabola.setAttribute('fill-opacity', count ? '0.08' : '0.25');
    comparison.setAttribute('visibility', count ? 'visible' : 'hidden');
    if (count) {
      const { total } = bars.get(count)!;
      share.setAttribute('width', String(width * total));
      result.textContent = slicePercent(count, percent.format(total));
    }
  };
}

const dimension = (a: Vector3, b: Vector3, cap: Vector3) => [
  a,
  b,
  a.clone().sub(cap),
  a.clone().add(cap),
  b.clone().sub(cap),
  b.clone().add(cap),
];

export function sliceLesson(
  parent: Group,
  spec: NonNullable<Spec['slices']>,
  colors: Palette,
  overlay: VectorNode
) {
  const scale = 1.04 / Math.max(spec.height, 3 * spec.radius);
  const h = spec.height * scale,
    r = spec.radius * scale;
  const base = -h / 2,
    gap = Math.max(0.38, r + 0.16);
  const bodies = new Group();
  parent.add(bodies);
  const ring = (x: number, y: number, radius: number) =>
    Array.from({ length: segments + 1 }, (_, i) => {
      const a = (2 * Math.PI * i) / segments;
      return new Vector3(x + radius * Math.cos(a), y, radius * Math.sin(a));
    });
  for (const [x, top, color] of [
    [-gap, 0, colors.far],
    [gap, r, colors.accent],
  ] as const) {
    const shell = new Mesh(
      new CylinderGeometry(top * 1.006, r * 1.006, h, segments, 1, true),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.15,
        side: DoubleSide,
        depthWrite: false,
      })
    );
    shell.position.x = x;
    bodies.add(shell);
    polyline(bodies, ring(x, base, r), color, 0.96);
    if (top) polyline(bodies, ring(x, base + h, r), color, 0.96);
    const edges = [-1, 1].flatMap(side => [
      new Vector3(x + side * r, base, 0),
      new Vector3(x + side * top, base + h, 0),
    ]);
    lines(bodies, edges, color, 0.84);
  }
  const leftRule = -gap - r - 0.11,
    rightRule = gap + r + 0.11,
    baseRule = base - 0.105;
  const measures = lines(
    bodies,
    [
      ...[leftRule, rightRule].flatMap(x =>
        dimension(new Vector3(x, base, 0), new Vector3(x, base + h, 0), new Vector3(0.029, 0, 0))
      ),
      ...[-gap, gap].flatMap(x =>
        dimension(
          new Vector3(x, baseRule, 0),
          new Vector3(x + r, baseRule, 0),
          new Vector3(0, 0.022, 0)
        )
      ),
    ],
    colors.ink,
    0.78
  );
  const ticks = lines(
    bodies,
    [0, 1, 2, 3].flatMap(n => [
      new Vector3(gap + r * 0.52, base + (h * n) / 3, r * Math.sqrt(1 - 0.52 ** 2)),
      new Vector3(gap + r + 0.12, base + (h * n) / 3, r * Math.sqrt(1 - 0.52 ** 2)),
    ]),
    colors.ink,
    0.9
  );
  const liquid = (x: number) => {
    const mesh = new Mesh(
      new CylinderGeometry(r, r, 1, segments),
      new MeshBasicMaterial({ color: colors.far })
    );
    mesh.frustumCulled = false;
    mesh.position.x = x;
    bodies.add(mesh);
    return mesh;
  };
  const tank = liquid(gap),
    donor = liquid(-gap);
  const flowSteps = 25;
  const stream = polyline(
    bodies,
    Array.from({ length: flowSteps }, () => new Vector3()),
    colors.far,
    0.94
  );
  const packet = new Mesh(
    new SphereGeometry(r * 0.075, 12, 8),
    new MeshBasicMaterial({ color: colors.far })
  );
  bodies.add(packet);
  const donorShape = donor.geometry.getAttribute('position').clone();
  const plane = new Mesh(
    new BoxGeometry(2 * (gap + r + 0.03), 0.003, 2.12 * r),
    new MeshBasicMaterial({
      color: colors.near,
      transparent: true,
      opacity: 0.23,
      depthWrite: false,
    })
  );
  bodies.add(plane);
  const disks = [-gap, gap].map((x, i) => {
    const disk = new Mesh(
      new CylinderGeometry(r, r, 0.005, segments),
      new MeshBasicMaterial({
        color: i ? colors.accent : colors.far,
        transparent: true,
        opacity: 0.87,
        depthWrite: false,
      })
    );
    disk.position.x = x;
    bodies.add(disk);
    return disk;
  });
  const chart = areaChart(overlay, colors, r / h);
  const at = (x: number, y: number, z = 0) =>
    new Vector3(x, y, z).multiplyScalar(bodies.scale.x).add(bodies.position);

  function fillDonor(donorHeight: number) {
    if (!donor.visible) return;
    const vertices = donor.geometry.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) {
      const top = donorShape.getY(i) > 0;
      const factor = top ? 1 - donorHeight : 1;
      vertices.setXYZ(
        i,
        donorShape.getX(i) * factor,
        top ? h * donorHeight : 0,
        donorShape.getZ(i) * factor
      );
    }
    vertices.needsUpdate = true;
    donor.position.y = base;
  }

  function transferLiquid(before: Beat, after: Beat, t: number, pour: boolean) {
    const from = before.sliceView ?? 'solids';
    const prior = before.poured ?? 0,
      next = after.poured ?? 0;
    const refilling = from !== 'pour' && prior === 0 && next === 0;
    const transferred = next > prior ? Math.max(0, (t - 0.24) / 0.76) : 0;
    const levels = liquidLevels(prior + (next - prior) * transferred, transferred);
    ticks.visible = pour;
    tank.visible = pour && levels.cylinder > 0;
    tank.scale.y = h * levels.cylinder;
    tank.position.y = base + tank.scale.y / 2;
    const loading = prior > 0 && next > prior && t < 0.24;
    const loadedHeight = loading ? t / 0.24 : levels.cone;
    const donorHeight = refilling ? t : loadedHeight;
    stream.visible = packet.visible = pour && transferred > 0 && transferred < 1;
    if (stream.visible) {
      const start = new Vector3(-gap, base + h * donorHeight, 0);
      const end = new Vector3(gap, base + tank.scale.y, 0);
      const path = (u: number) =>
        start
          .clone()
          .lerp(end, u)
          .add(new Vector3(0, h * u * (1 - u), 0));
      moveVertices(
        stream,
        Array.from({ length: flowSteps }, (_, index) => path(index / (flowSteps - 1)))
      );
      packet.position.copy(path(transferred));
    }
    donor.visible = pour && donorHeight > 0 && (next > prior || next === 0);
    fillDonor(donorHeight);
    return { levels, next };
  }

  return (before: Beat, after: Beat, t: number, strength: number, cue: number) => {
    const from = before.sliceView ?? 'solids',
      to = after.sliceView ?? 'solids';
    const amount = (view: string) => (from === view ? 1 - t : 0) + (to === view ? t : 0);
    const slicing = amount('slices') + amount('bars');
    bodies.position.x = 0.24 - 0.34 * slicing;
    bodies.scale.setScalar(1 - 0.18 * slicing);
    measures.visible = amount('solids') > 0;
    measures.material.opacity = 0.78 * amount('solids') * strength;
    const pour = to === 'pour';
    const { levels, next } = transferLiquid(before, after, t, pour);
    const z = to === 'bars' ? 1 : cue;
    plane.visible = slicing > 0;
    plane.position.y = base + h * z;
    disks.forEach((disk, i) => {
      disk.visible = slicing > 0 && (i === 1 || z < 1);
      disk.position.y = plane.position.y + 0.006;
      disk.scale.set(i ? 1 : 1 - z, 1, i ? 1 : 1 - z);
    });
    const defaultBars = to === 'bars' ? 4 : undefined;
    const barCount = t === 1 ? (after.bars ?? defaultBars) : before.bars;
    chart(z, barCount, slicing * strength);

    const labels: { text: string; point: Vector3 }[] =
      slicing > 0
        ? []
        : [
            { text: copy.cone, point: at(-gap, base - 0.18) },
            { text: copy.cylinder, point: at(gap, base - 0.18) },
          ];
    if (to === 'solids') {
      for (const x of [leftRule - 0.055, rightRule + 0.055])
        labels.push({ text: sliceDimensions.height, point: at(x, 0) });
      for (const x of [-gap, gap])
        labels.push({ text: sliceDimensions.radius, point: at(x + r / 2, baseRule - 0.06) });
    }
    if (pour && t === 1 && next > 0)
      labels.push({
        text: sliceDimensions.levels[next],
        point: at(gap + r + 0.22, base + (h * next) / 3, r * Math.sqrt(1 - 0.52 ** 2)),
      });
    return {
      rows: [],
      target: pour ? at(gap, base + h * levels.cylinder) : at(-gap, plane.position.y),
      labels,
    };
  };
}
