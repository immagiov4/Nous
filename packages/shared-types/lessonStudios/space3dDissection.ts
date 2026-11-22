import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { derived, fitLabel, textAt } from './chart';
import { MIN_TEXT_GAP_PX } from './layoutValidation';
import { areaComparison, copy } from './space3dCopy.it';
import type { Palette } from './space3dDraw';
import { lines, lit, placeOpacity } from './space3dDraw';
import type { Beat, Space3dSpec } from './space3dSpec';
import { svg, type VectorNode } from './vectorScene';

const axes = [0, 1, 2].map(axis => new Vector3().setComponent(axis, 1));
const diagonal = new Vector3(1, 1, 1).normalize();
const identity = new Quaternion();
const upright = new Quaternion().setFromAxisAngle(axes[2], Math.PI);
const faces = [1, 2, 3, 1, 3, 4, 0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4];
const square = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

function pyramidVertices(baseAxis: number) {
  const a = axes[(baseAxis + 1) % 3],
    b = axes[(baseAxis + 2) % 3];
  return [
    new Vector3(),
    ...square.map(([u, v]) => axes[baseAxis].clone().addScaledVector(a, u).addScaledVector(b, v)),
  ];
}

function matchingSections(side: number, fraction: number) {
  const width = side * (1 - fraction);
  return { width, radius: width / Math.sqrt(Math.PI) };
}

// A horizontal band keeps its area when its width is traded for height in the comparison strip.
function areaStrip(
  width: number,
  radius: number | undefined,
  mix: number,
  fromX: number,
  fromY: number,
  toY: number,
  strip: { width: number; centerX: number }
) {
  const half = radius ?? width / 2;
  const total = radius === undefined ? width ** 2 : Math.PI * radius ** 2;
  const semicircle = (y: number) => Math.sqrt(Math.max(0, half ** 2 - y ** 2));
  const primitive = (y: number) =>
    y * semicircle(y) + half ** 2 * Math.asin(Math.max(-1, Math.min(1, y / half)));
  const centerX = fromX + (strip.centerX - fromX) * mix;
  const centerY = fromY + (toY - fromY) * mix;
  const bands = 32;
  const area = total / bands;
  let cursor = 0;
  let base = -half;
  const edges = Array.from({ length: bands }, (_, i) => {
    let lower = base,
      upper = half;
    for (let step = 0; radius !== undefined && step < 25; step++) {
      const middle = (lower + upper) / 2;
      if (primitive(middle) < -total / 2 + area * (i + 1)) lower = middle;
      else upper = middle;
    }
    const end = radius === undefined ? base + width / bands : (lower + upper) / 2;
    const thickness = end - base;
    base = end;
    const originalSpan = area / thickness;
    const span = originalSpan + (strip.width - originalSpan) * mix;
    const top = cursor;
    cursor += area / span;
    return [span / 2, top, cursor];
  });
  const halfHeight = cursor / 2;
  const boundary = (side: number, order: typeof edges) =>
    order.flatMap(([span, top, bottom]) => {
      const x = centerX + side * span;
      const band = side < 0 ? [top, bottom] : [bottom, top];
      return band.map(y => `${x} ${centerY + y - halfHeight}`);
    });
  const outline = (bands: typeof edges) =>
    'M' + [...boundary(-1, bands), ...boundary(1, [...bands].reverse())].join('L') + 'Z';
  const marks = [8, 16, 24]
    .map(index => {
      const [span, , bottom] = edges[index - 1];
      const y = centerY + bottom - halfHeight;
      return `M${centerX - span} ${y}H${centerX + span}`;
    })
    .join('');
  const tiles = [3, 11, 19, 27].flatMap(index => {
    const [span, top, bottom] = edges[index];
    const y = centerY + (top + bottom) / 2 - halfHeight;
    return Array.from({ length: 6 }, (_, col) => [centerX + span * ((2 * col + 1) / 6 - 1), y]);
  });
  const quarters = Array.from({ length: 4 }, (_, i) => outline(edges.slice(i * 8, (i + 1) * 8)));
  return { d: outline(edges), height: total / strip.width, marks, tiles, quarters };
}

function pyramid(color: Palette['ink'], baseAxis: number, opacity = 0.62) {
  const group = new Group();
  const vertices = pyramidVertices(baseAxis);
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      faces.flatMap(index => vertices[index].toArray()),
      3
    )
  );
  geometry.computeVertexNormals();
  // Double-sided faces keep the partition visible during each rigid turn.
  const material = lit(color, opacity);
  material.side = DoubleSide;
  material.depthWrite = false;
  const body = new Mesh(geometry, material);
  const edges = new LineSegments(
    new EdgesGeometry(geometry),
    new LineBasicMaterial({ color, transparent: true })
  );
  group.add(body, edges);
  return group;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const phase = (t: number, from: number, to: number) =>
  smooth(Math.min(1, Math.max(0, (t - from) / (to - from))));
const cubeApex = new Vector3(-0.5, -0.5, -0.5);
const uprightApex = (x: number) => new Vector3(x + 0.5, 0.5, -0.5);

export function dissectionLesson(
  parent: Group,
  spec: NonNullable<Space3dSpec['slices']>,
  colors: Palette,
  overlay: VectorNode
) {
  if (!overlay.viewport) throw new Error('The dissection needs a measured stage');
  const { width: stageWidth, height: stageHeight } = overlay.viewport;
  const gap = MIN_TEXT_GAP_PX;
  const comparisonX = stageWidth * 0.75;
  const stripWidth = stageWidth / 2 - 2 * gap;
  const strip = { width: stripWidth, centerX: comparisonX };
  const tints = [colors.near, colors.accent, colors.far];
  const partition = new Group(),
    slices = new Group(),
    comparison = new Group();
  parent.add(partition, slices, comparison);
  const pieces = tints.map((color, axis) => {
    const piece = pyramid(color, axis);
    partition.add(piece);
    return {
      piece,
      open: uprightApex((axis - 1) * 1.27),
      turn: upright
        .clone()
        .multiply(new Quaternion().setFromAxisAngle(diagonal, ((1 - axis) * 2 * Math.PI) / 3)),
    };
  });
  const cubeFrame = new LineSegments(
    new EdgesGeometry(new BoxGeometry()),
    new LineBasicMaterial({
      color: colors.ink,
      transparent: true,
      opacity: 0.6,
    })
  );
  const joint = new Mesh(new SphereGeometry(0.027, 20, 16), lit(colors.ink));
  joint.position.copy(cubeApex);
  joint.material.depthTest = false;
  joint.renderOrder = 5;
  partition.add(cubeFrame, joint);

  const side = Math.sqrt(Math.PI) * spec.radius;
  const radius = matchingSections(1, 0).radius;
  const height = spec.height / side;
  const addPyramid = (group: Group, x: number, opacity?: number) => {
    const body = pyramid(tints[1], 1, opacity);
    body.position.copy(uprightApex(x)).setY(height / 2);
    body.quaternion.copy(upright);
    body.scale.y = height;
    group.add(body);
  };
  const cylinder = (group: Group, x: number, tip: number, color: Palette['ink']) => {
    const geometry = new CylinderGeometry(tip, radius, height, 64);
    const solid = new Mesh(geometry, lit(color, 0.34));
    solid.material.depthWrite = false;
    const outline = new LineSegments(
      new EdgesGeometry(geometry, 14),
      new LineBasicMaterial({ color })
    );
    solid.position.x = outline.position.x = x;
    group.add(solid, outline);
  };

  const sliceX = 0.77;
  addPyramid(slices, -sliceX, 0.22);
  cylinder(slices, sliceX, 0, tints[0]);
  const squareCut = new Mesh(new PlaneGeometry(1, 1), lit(tints[1], 0.91));
  const diskCut = new Mesh(new CircleGeometry(1, 64), lit(tints[0], 0.91));
  const plane = new Mesh(new PlaneGeometry(3.05, 1.4), lit(colors.ink, 0.12));
  for (const cut of [squareCut, diskCut, plane]) {
    cut.rotation.x = -Math.PI / 2;
    cut.material.side = DoubleSide;
    cut.material.depthWrite = false;
    slices.add(cut);
  }
  plane.renderOrder = 3;
  squareCut.renderOrder = diskCut.renderOrder = 4;

  const inset = svg(overlay, 'g', {});
  const bandColors = [colors.accent, colors.far, colors.near, colors.ink];
  const quarterBands = Array.from({ length: 2 }, () =>
    bandColors.map(tint =>
      svg(inset, 'path', {
        fill: tint.getStyle(),
        'fill-opacity': 0.36,
      })
    )
  );
  const strips = [tints[1], tints[0]].map(tint =>
    svg(inset, 'path', {
      fill: 'none',
      stroke: tint.getStyle(),
      'stroke-width': 1.5,
    })
  );
  const stripes = [tints[1], tints[0]].map(tint =>
    svg(inset, 'path', {
      fill: 'none',
      stroke: tint.getStyle(),
      'stroke-width': 1.5,
      'stroke-opacity': 0.82,
    })
  );
  const equalEnds = svg(inset, 'path', {
    fill: 'none',
    stroke: colors.ink.getStyle(),
    'stroke-opacity': 0.48,
    'stroke-dasharray': '3 4',
  });
  const flatSquare = svg(inset, 'rect', {
    fill: tints[1].getStyle(),
    'fill-opacity': 0.65,
    stroke: tints[1].getStyle(),
    'stroke-width': 2,
  });
  const flatDisk = svg(inset, 'circle', {
    fill: tints[0].getStyle(),
    'fill-opacity': 0.65,
    stroke: tints[0].getStyle(),
    'stroke-width': 2,
  });
  const connects = [flatSquare, flatDisk].map(() =>
    svg(inset, 'path', {
      fill: 'none',
      stroke: colors.ink.getStyle(),
      'stroke-opacity': 0.5,
      'stroke-dasharray': '3 4',
    })
  );
  for (const stripe of stripes)
    inset.children.push(inset.children.splice(inset.children.indexOf(stripe), 1)[0]);
  const tiles = [tints[1], tints[0]].map(tint =>
    Array.from({ length: 24 }, () =>
      svg(inset, 'circle', {
        fill: tint.getStyle(),
        stroke: colors.surface.getStyle(),
        'stroke-width': 0.9,
      })
    )
  );
  const area = textAt(inset, comparisonX, stageHeight - 2 * gap, '', 'middle', 'parameter');
  const compareLabels = svg(overlay, 'g', {});
  const identities = [
    textAt(
      compareLabels,
      stageWidth / 4,
      stageHeight - 2 * gap,
      copy.pyramidRatio,
      'middle',
      'parameter'
    ),
    textAt(
      compareLabels,
      comparisonX,
      stageHeight - 2 * gap,
      copy.coneRatio,
      'middle',
      'parameter'
    ),
  ];
  let conclusionCaptionTop = stageHeight;
  for (const label of identities) {
    if (!fitLabel(label, label.textContent, stripWidth)) {
      overlay.data.unplacedRequiredLabel = 'true';
    }
    const { top, bottom } = label.glyphs().bounds;
    const y = stageHeight - gap - bottom;
    label.setAttribute('y', y);
    conclusionCaptionTop = Math.min(conclusionCaptionTop, y + top);
  }

  const positions = [-1.78, -0.6, 0.6, 1.78];
  for (const [axis, color] of tints.entries()) {
    const piece = pyramid(color, axis);
    piece.position.set(positions[0] - 0.5, -height / 2, -0.5);
    piece.scale.y = height;
    comparison.add(piece);
  }
  addPyramid(comparison, positions[1]);
  cylinder(comparison, positions[2], 0, tints[0]);
  cylinder(comparison, positions[3], radius, colors.ink);
  const fills = [
    new BoxGeometry(0.98, 1, 0.98),
    new CylinderGeometry(radius * 0.98, radius * 0.98, 1, 64),
  ].map((geometry, index) => {
    const tint = index === 0 ? tints[1] : tints[0];
    const mesh = new Mesh(geometry, lit(tint, 0.83));
    mesh.position.x = positions[index === 0 ? 0 : 3];
    comparison.add(mesh);
    return mesh;
  });
  const start = positions[0] - 0.53,
    end = positions[3] + 0.53;
  lines(
    comparison,
    [-height / 2, height / 2].flatMap(y => [
      new Vector3(start, y, 0.66),
      new Vector3(end, y, 0.66),
    ]),
    colors.ink,
    0.43
  );

  function movePieces(view: Beat['sliceView'], strength: number, cue: number) {
    const reassembly = view === 'reassemble' ? 1 - cue : 1;
    const move = view === 'dissect' ? cue : reassembly;
    const turn = phase(move, 0.34, 0.88);
    const extract = phase(move, 0.03, 0.4);
    const land = phase(move, 0.44, 0.97);
    const superposition = view === 'reassemble' ? 1 - phase(cue, 0, 0.25) : 0;
    const overlay = view === 'superpose' ? phase(cue, 0.05, 0.62) : superposition;
    for (const [axis, { piece, open, turn: rotation }] of pieces.entries()) {
      const separated = cubeApex.clone().addScaledVector(axes[axis], 0.62 * extract);
      const arranged = open.clone().lerp(uprightApex(0), overlay);
      piece.position.copy(separated).lerp(arranged, land);
      piece.quaternion.copy(identity).slerp(rotation, turn);
      placeOpacity(piece, strength * (axis === 1 ? 1 : 1 - overlay * 0.36));
    }
    const reassemblyTurn = view === 'reassemble' ? 1 - phase(cue, 0, 0.18) : 0;
    const inspectionTurn = view === 'superpose' ? phase(cue, 0.61, 1) : reassemblyTurn;
    partition.rotation.set(-0.45 * inspectionTurn, 1.12 * inspectionTurn, 0);
    joint.visible = move < 0.12;
    cubeFrame.visible = move < 0.92;
    cubeFrame.material.opacity = strength * (0.74 - 0.62 * extract);
  }

  return (_before: Beat, after: Beat, _t: number, strength: number, cue: number) => {
    const view = after.sliceView;
    const sweeping = view === 'cavalieri',
      conclusion = view === 'conclusion';
    partition.visible = !sweeping && !conclusion;
    slices.visible = sweeping;
    comparison.visible = conclusion;
    inset.setAttribute('visibility', sweeping && strength > 0 ? 'visible' : 'hidden');
    compareLabels.setAttribute('visibility', conclusion && strength > 0 ? 'visible' : 'hidden');
    const center = new Vector3();
    let frame = {
      center: new Vector3(0, 0.13, 0),
      yaw: 0.44,
      pitch: 0.43,
      distance: 7.35,
      shift: 0,
    };

    if (partition.visible) movePieces(view, strength, cue);

    if (sweeping) {
      const fraction = 0.002 + 0.56 * phase(cue, 0.48, 1);
      const { width, radius: cutRadius } = matchingSections(1, fraction);
      const y = height * (fraction - 0.5);
      plane.position.y = y - 0.001;
      squareCut.position.set(-sliceX + fraction / 2, y, -fraction / 2);
      diskCut.position.set(sliceX, y, 0);
      squareCut.scale.setScalar(width);
      diskCut.scale.setScalar(cutRadius);
      frame = { center: new Vector3(0, 0, 0), yaw: 0.14, pitch: 0.35, distance: 11.9, shift: 0.25 };
      const insetScale = Math.min(stageWidth / 8 - gap, stageHeight / 4);
      const dimension = width * insetScale;
      const disk = cutRadius * insetScale;
      const unfold = phase(cue, 0.04, 0.27);
      area.textContent = areaComparison(derived((side * width) ** 2));
      const withinPanel = area.glyphs().advance <= stripWidth;
      area.setAttribute('x', withinPanel ? comparisonX : stageWidth / 2);
      return {
        rows: [],
        target: center,
        frame,
        meshArea: {
          left: gap,
          right: stageWidth / 2 - gap,
          top: gap,
          bottom: withinPanel ? stageHeight - gap : stageHeight - 4 * gap,
        },
        project(project: (point: Vector3) => [number, number]) {
          const [a, b] = [squareCut, diskCut].map(cut => project(cut.position));
          const baseline = stageHeight / 2;
          const flatX = [stageWidth * 0.625, stageWidth * 0.875];
          const stack = phase(cue, 0.25, 0.36) * (1 - phase(cue, 0.41, 0.53));
          const stripY = [stageHeight / 3, (stageHeight * (2 - stack)) / 3];
          const ribbon = [
            areaStrip(dimension, undefined, unfold, flatX[0], baseline, stripY[0], strip),
            areaStrip(dimension, disk, unfold, flatX[1], baseline, stripY[1], strip),
          ];
          strips.forEach((strip, i) => {
            strip.setAttribute('d', ribbon[i].d);
            stripes[i].setAttribute('d', ribbon[i].marks);
            for (const [index, band] of quarterBands[i].entries())
              band.setAttribute('d', ribbon[i].quarters[index]);
            for (const [index, [x, y]] of ribbon[i].tiles.entries()) {
              tiles[i][index].setAttribute('cx', String(x));
              tiles[i][index].setAttribute('cy', String(y));
              tiles[i][index].setAttribute('r', String(dimension * 0.034));
            }
          });
          const startY = stripY[0] + ribbon[0].height / 2;
          const endY = stripY[1] - ribbon[1].height / 2;
          equalEnds.setAttribute(
            'd',
            unfold === 1 && endY > startY
              ? [comparisonX - stripWidth / 2, comparisonX + stripWidth / 2]
                  .map(x => `M${x} ${startY}V${endY}`)
                  .join('')
              : ''
          );
          for (const [i, [x, y]] of [a, b].entries()) {
            connects[i].setAttribute(
              'd',
              `M${x} ${y}L${flatX[i]} ${baseline - (i === 0 ? dimension / 2 : disk)}`
            );
            connects[i].setAttribute('opacity', String(1 - unfold));
          }
          flatSquare.setAttribute('x', String(flatX[0] - dimension / 2));
          flatSquare.setAttribute('y', String(baseline - dimension / 2));
          flatSquare.setAttribute('width', String(dimension));
          flatSquare.setAttribute('height', String(dimension));
          flatDisk.setAttribute('cx', String(flatX[1]));
          flatDisk.setAttribute('cy', String(baseline));
          flatDisk.setAttribute('r', String(disk));
          for (const shape of [flatSquare, flatDisk])
            shape.setAttribute('opacity', String(1 - unfold));
        },
      };
    }

    if (conclusion) {
      frame = { center: new Vector3(0, -0.17, 0), yaw: 0.1, pitch: 0.25, distance: 9.25, shift: 0 };
      const filledHeight = (height * phase(cue, 0, 1)) / 3;
      for (const fill of fills) {
        fill.visible = filledHeight > 0;
        fill.scale.y = filledHeight;
        fill.position.y = (filledHeight - height) / 2;
      }
      identities[0].setAttribute('opacity', String(phase(cue, 0, 0.25)));
      identities[1].setAttribute('opacity', String(phase(cue, 0.25, 1)));
    }
    return {
      rows: [],
      target: center,
      frame,
      meshArea: conclusion
        ? { left: gap, right: stageWidth - gap, top: gap, bottom: conclusionCaptionTop - gap }
        : undefined,
    };
  };
}
