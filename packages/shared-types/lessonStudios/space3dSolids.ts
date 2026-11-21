import type { Group } from 'three';
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { derived } from './chart';
import { copy, solidNames } from './space3dCopy.it';
import type { Palette } from './space3dDraw';
import { lit, moveVertices, polyline, wireBox } from './space3dDraw';
import { overlayMark as svg, textAt } from './space3dOverlay';
import type { Beat, Spec } from './space3dSpec';
import type { VectorNode } from './vectorScene';

const radialSegments = 48;
const epsilon = 1e-8;

export function solidMeasures(solid: NonNullable<Spec['solid']>) {
  switch (solid.kind) {
    case 'cube':
      return { volume: solid.side ** 3, area: 6 * solid.side ** 2 };
    case 'prism': {
      const [width, height, depth] = solid.size;
      return {
        volume: (width * depth * height) / 2,
        area: width * depth + height * (width + depth + Math.hypot(width, depth)),
      };
    }
    case 'pyramid': {
      const [width, height, depth] = solid.size;
      return {
        volume: (width * depth * height) / 3,
        area:
          width * depth +
          width * Math.hypot(height, depth / 2) +
          depth * Math.hypot(height, width / 2),
      };
    }
    case 'cylinder':
    case 'cone': {
      const { radius, height } = solid;
      const base = Math.PI * radius ** 2;
      return solid.kind === 'cylinder'
        ? { volume: base * height, area: 2 * base + 2 * Math.PI * radius * height }
        : {
            volume: (base * height) / 3,
            area: base + Math.PI * radius * Math.hypot(radius, height),
          };
    }
    case 'sphere':
      return {
        volume: (4 * Math.PI * solid.radius ** 3) / 3,
        area: 4 * Math.PI * solid.radius ** 2,
      };
  }
}

function polyhedron(width: number, height: number, depth: number, pyramid: boolean) {
  const x = width / 2,
    y = height / 2,
    z = depth / 2;
  const points = [
    [-x, -y, -z],
    [-x, -y, z],
    [x, -y, -z],
    [x, -y, z],
    ...(pyramid
      ? [[0, y, 0]]
      : [
          [-x, y, -z],
          [-x, y, z],
          [x, y, -z],
        ]),
  ];
  const faces = pyramid
    ? [0, 2, 1, 1, 2, 3, 0, 1, 4, 1, 3, 4, 3, 2, 4, 2, 0, 4]
    : [0, 2, 1, 4, 5, 6, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 0, 4, 2, 4, 6];
  const geometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute(
      faces.flatMap(index => points[index]),
      3
    )
  );
  geometry.computeVertexNormals();
  return geometry;
}

export function solidLesson(parent: Group, solid: NonNullable<Spec['solid']>, colors: Palette) {
  const geometry = (() => {
    switch (solid.kind) {
      case 'cube':
        return new BoxGeometry(solid.side, solid.side, solid.side);
      case 'sphere':
        return new SphereGeometry(solid.radius, radialSegments, 24);
      case 'cylinder':
      case 'cone':
        return new CylinderGeometry(
          solid.kind === 'cone' ? 0 : solid.radius,
          solid.radius,
          solid.height,
          radialSegments
        );
      default:
        return polyhedron(...solid.size, solid.kind === 'pyramid');
    }
  })();
  geometry.computeBoundingBox();
  const span = geometry.boundingBox!.getSize(new Vector3());
  const mesh = new Mesh(geometry, lit(colors.accent));
  mesh.material.side = DoubleSide;
  mesh.scale.setScalar(1.18 / Math.max(...span.toArray()));
  parent.add(mesh);
  const { volume, area } = solidMeasures(solid);
  return () => ({
    rows: [
      [solidNames[solid.kind], copy.solid],
      [derived(volume), copy.volume],
      [derived(area), copy.area],
    ],
    target: mesh.position,
  });
}

export function sliceAreas({ radius, height, n }: NonNullable<Spec['slices']>) {
  const base = Math.PI * radius ** 2;
  const thickness = height / n;
  return Array.from({ length: n }, (_, index) => {
    const lower = 1 - index / n;
    const upper = 1 - (index + 1) / n;
    return {
      cylinder: base,
      cone: (base * (lower ** 2 + lower * upper + upper ** 2)) / 3,
      lower,
      upper,
      thickness,
    };
  });
}

export function sectionPlane(section: Beat['section'] = 'square') {
  const presets = {
    square: [[0, 1, 0], 0.12],
    triangle: [[1, 1, 1], 0.5 / Math.sqrt(3)],
    hexagon: [[1, 1, 1], 0],
    trapezoid: [[0.6, 1, 0.2], 0.38],
  } as const;
  const [normal, offset] =
    typeof section === 'string' ? presets[section] : [section.normal, section.offset];
  return { normal: new Vector3(...normal).normalize(), offset };
}

const corners = Array.from(
  { length: 8 },
  (_, bits) =>
    new Vector3(
      ...(([1, 2, 4] as const).map(bit => (bits & bit ? 0.5 : -0.5)) as [number, number, number])
    )
);
const cubeEdges = corners.flatMap((a, index) =>
  [1, 2, 4].filter(bit => !(index & bit)).map(bit => [a, corners[index | bit]])
);

export function cubeSection(normal: Vector3, offset: number) {
  const points: Vector3[] = [];
  const add = (point: Vector3) => {
    if (!points.some(other => other.distanceToSquared(point) < epsilon ** 2)) points.push(point);
  };
  for (const [a, b] of cubeEdges) {
    const dA = normal.dot(a) - offset;
    const dB = normal.dot(b) - offset;
    if (Math.abs(dA) < epsilon) add(a.clone());
    if (Math.abs(dB) < epsilon) add(b.clone());
    if (dA * dB < 0) add(a.clone().lerp(b, dA / (dA - dB)));
  }
  const center = points
    .reduce((sum, point) => sum.add(point), new Vector3())
    .divideScalar(points.length || 1);
  const cross = new Vector3(1, 0, 0);
  if (Math.abs(normal.x) > 0.9) cross.set(0, 1, 0);
  const u = cross.cross(normal).normalize();
  const v = normal.clone().cross(u);
  const angle = (point: Vector3) =>
    Math.atan2(v.dot(point.clone().sub(center)), u.dot(point.clone().sub(center)));
  return points.sort((a, b) => angle(a) - angle(b));
}

export function sectionLesson(parent: Group, colors: Palette, overlay: VectorNode) {
  wireBox(parent, colors.ink, 0.65);
  const panel = new Mesh(
    new BoxGeometry(1.36, 1.36, 0.005),
    new MeshBasicMaterial({
      color: colors.accent,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    })
  );
  const surface = new Mesh(
    new BufferGeometry().setAttribute(
      'position',
      new Float32BufferAttribute(new Float32Array(36), 3)
    ),
    new MeshBasicMaterial({
      color: colors.accent,
      side: DoubleSide,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    })
  );
  surface.frustumCulled = false;
  const outline = polyline(
    parent,
    Array.from({ length: 7 }, () => new Vector3()),
    colors.ink,
    0.92
  );
  const dots = Array.from(
    { length: 6 },
    () => new Mesh(new SphereGeometry(0.024, 12, 8), lit(colors.accent))
  );
  parent.add(panel, surface, ...dots);
  const z = new Vector3(0, 0, 1);
  const faceOn = svg(overlay, 'g', {});
  const cutLabel = textAt(faceOn, 834, 338, copy.cutShape, 'middle', 'axis-label');
  const profileScale = 87;
  const profile = svg(faceOn, 'polyline', {
    fill: colors.accent.getStyle(),
    'fill-opacity': 0.28,
    stroke: colors.accent.getStyle(),
    'stroke-width': 1.7,
  });
  return (before: Beat, after: Beat, t: number, strength: number, cue: number) => {
    const source = sectionPlane(before.section);
    const destination = sectionPlane(after.section);
    if (source.normal.dot(destination.normal) < 0) {
      destination.normal.negate();
      destination.offset *= -1;
    }
    const planeProgress = Math.min(1, t * 2);
    const morphProgress = Math.max(0, t * 2 - 1);
    const normal = source.normal.clone().lerp(destination.normal, planeProgress).normalize();
    const offset = source.offset + (destination.offset - source.offset) * planeProgress;
    const vertices = cubeSection(normal, offset);
    panel.quaternion.setFromUnitVectors(z, normal);
    panel.position.copy(normal).multiplyScalar(offset);
    const fan = vertices
      .slice(2)
      .flatMap((point, index) => [vertices[0], vertices[index + 1], point]);
    surface.geometry.setDrawRange(0, fan.length);
    moveVertices(surface, fan);
    const path = vertices.length > 2 ? [...vertices, vertices[0]] : vertices;
    outline.geometry.setDrawRange(0, path.length);
    moveVertices(outline, path);
    for (const [index, dot] of dots.entries()) {
      dot.visible = index < vertices.length;
      if (dot.visible) dot.position.copy(vertices[index]);
    }
    const morphNormal = source.normal.clone().lerp(destination.normal, morphProgress).normalize();
    const morphOffset = source.offset + (destination.offset - source.offset) * morphProgress;
    const flat = cubeSection(morphNormal, morphOffset);
    const center = flat
      .reduce((sum, point) => sum.add(point), new Vector3())
      .divideScalar(flat.length || 1);
    const facing = panel.quaternion.clone().setFromUnitVectors(morphNormal, z);
    if (after.section === 'trapezoid' && morphProgress > 0) {
      const { normal, offset } = destination;
      const polygon = cubeSection(normal, offset);
      const basis = panel.quaternion.clone().setFromUnitVectors(normal, z);
      const edges = polygon.map((point, i) => polygon[(i + 1) % polygon.length].clone().sub(point));
      const parallel = edges.find(
        (edge, i) =>
          edge
            .clone()
            .cross(edges[(i + 2) % edges.length])
            .length() < epsilon
      )!;
      parallel.applyQuaternion(basis);
      const angle = Math.atan2(parallel.y, parallel.x);
      const nearestHorizontal = angle - Math.round(angle / Math.PI) * Math.PI;
      facing.premultiply(
        panel.quaternion.clone().setFromAxisAngle(z, -nearestHorizontal * morphProgress)
      );
    }
    const lift = before === after ? cue : 1;
    faceOn.setAttribute('opacity', String(strength));
    cutLabel.setAttribute('opacity', String(lift));
    return {
      rows: [],
      target: vertices
        .reduce((point, vertex) => point.add(vertex), new Vector3())
        .divideScalar(vertices.length || 1),
      project(project: (point: Vector3) => [number, number]) {
        profile.setAttribute(
          'points',
          flat
            .map(vertex => {
              const [x, y] = project(vertex);
              const point = vertex.clone().sub(center).applyQuaternion(facing);
              const u = 834 + point.x * profileScale;
              const v = 241 - point.y * profileScale;
              return x + (u - x) * lift + ',' + (y + (v - y) * lift);
            })
            .join(' ')
        );
      },
    };
  };
}
