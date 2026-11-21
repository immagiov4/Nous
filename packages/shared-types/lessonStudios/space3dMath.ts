import { Box3, Ray, Triangle, Vector3 } from 'three';
import type { Space3dSpec } from './space3dSpec';

export const HALF = 0.5;
export const origin = new Vector3();
const axes = [0, 1, 2] as const;
const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => new Vector3(x, y, z))));
const sphere = (x: number, y: number, z: number, radius: number) => Math.hypot(x, y, z) - radius;

export function sdf(shape: NonNullable<Space3dSpec['shape']>, x: number, y: number, z: number) {
  switch (shape) {
    case 'sphere':
      return sphere(x, y, z, 0.33);
    case 'torus':
      return Math.hypot(Math.hypot(x, z) - 0.26, y) - 0.105;
    case 'box': {
      const a = Math.abs(x) - 0.32,
        b = Math.abs(y) - 0.23,
        c = Math.abs(z) - 0.27;
      return (
        Math.hypot(Math.max(a, 0), Math.max(b, 0), Math.max(c, 0)) + Math.min(Math.max(a, b, c), 0)
      );
    }
    case 'capsule':
      return sphere(x, y - Math.max(-0.21, Math.min(0.21, y)), z, 0.18);
    case 'bunny-like blob':
      return Math.min(
        sphere(x, y + 0.13, z, 0.235),
        sphere(x + 0.12, y - 0.16, z, 0.15),
        sphere(x - 0.115, y - 0.18, z, 0.15)
      );
  }
}

export function sampleSolid(shape: NonNullable<Space3dSpec['shape']>, resolution: number) {
  const points: Vector3[] = [];
  const coordinate = (index: number) => (index + 0.5) / resolution - HALF;
  for (let x = 0; x < resolution; x++) {
    for (let y = 0; y < resolution; y++) {
      for (let z = 0; z < resolution; z++) {
        const a = coordinate(x),
          b = coordinate(y),
          c = coordinate(z);
        if (sdf(shape, a, b, c) <= 0) points.push(new Vector3(a, b, c));
      }
    }
  }
  return points;
}

export type Node = {
  center: Vector3;
  size: number;
  level: number;
  occupied: boolean;
  children: Node[];
};

export function octree(samples: Vector3[], depth: number): Node {
  function split(points: Vector3[], center: Vector3, size: number, level: number): Node {
    const children: Node[] = [];
    if (points.length && level < depth) {
      const octant = (point: Vector3) =>
        (point.x >= center.x ? 4 : 0) + (point.y >= center.y ? 2 : 0) + Number(point.z >= center.z);
      const bins: Vector3[][] = corners.map(() => []);
      for (const point of points) bins[octant(point)].push(point);
      for (const [index, corner] of corners.entries()) {
        children.push(
          split(bins[index], center.clone().addScaledVector(corner, size / 4), size / 2, level + 1)
        );
      }
    }
    return { center, size, level, occupied: points.length > 0, children };
  }
  return split(samples, origin, 1, 0);
}

export type Visit = { node: Node; kind: 'skip' | 'descend' | 'hit'; enter: number; exit: number };

export function traverse(root: Node, ray: Ray, depth: number) {
  const visits: Visit[] = [];
  const bounds = new Box3();
  const extent = new Vector3();
  const intersection = new Vector3();
  function interval(node: Node) {
    bounds.setFromCenterAndSize(node.center, extent.setScalar(node.size));
    if (!ray.intersectBox(bounds, intersection)) return [];
    const enter = bounds.containsPoint(ray.origin)
      ? 0
      : intersection.sub(ray.origin).dot(ray.direction);
    const farOrigin = ray.at(enter + node.size * 2, new Vector3());
    const reverse = new Ray(farOrigin, ray.direction.clone().negate());
    const exit = reverse.intersectBox(bounds, intersection)!.sub(ray.origin).dot(ray.direction);
    return [{ node, enter, exit }];
  }

  function visit(span: Omit<Visit, 'kind'>) {
    const { node } = span;
    const occupiedKind = node.level < depth && node.children.length ? 'descend' : 'hit';
    const kind = !node.occupied ? 'skip' : occupiedKind;
    visits.push({ ...span, kind });
    if (kind === 'descend') {
      for (const child of node.children.flatMap(interval).sort((a, b) => a.enter - b.enter))
        visit(child);
    }
  }
  for (const span of interval(root)) visit(span);
  return visits;
}

export function trianglesOf(vertices: NonNullable<Space3dSpec['triangles']>) {
  return vertices.map(
    ([a, b, c]) => new Triangle(new Vector3(...a), new Vector3(...b), new Vector3(...c))
  );
}

export function voxelize(triangle: Triangle, resolution: number, mode: Space3dSpec['mode']) {
  const vertices = [triangle.a, triangle.b, triangle.c];
  const normal = triangle.getNormal(new Vector3());
  const axis = axes.reduce((a, b) =>
    Math.abs(normal.getComponent(b)) > Math.abs(normal.getComponent(a)) ? b : a
  );
  const plane = triangle.a.dot(normal);
  const bounds = new Box3().setFromPoints(vertices);
  const boundary = (coord: number) => (coord + HALF) * resolution;
  const withinGrid = (index: number) => Math.max(0, Math.min(resolution - 1, index));
  const min = axes.map(i => withinGrid(Math.ceil(boundary(bounds.min.getComponent(i))) - 1));
  const max = axes.map(i => withinGrid(Math.floor(boundary(bounds.max.getComponent(i)))));
  const size = 1 / resolution;
  const cell = new Box3();
  const extent = new Vector3().setScalar(size);
  const projected = new Vector3();
  const candidates: { center: Vector3; hit: boolean }[] = [];
  for (let y = max[1]; y >= min[1]; y--) {
    for (let x = min[0]; x <= max[0]; x++) {
      for (let z = min[2]; z <= max[2]; z++) {
        const center = new Vector3(x + HALF, y + HALF, z + HALF)
          .multiplyScalar(size)
          .subScalar(HALF);
        cell.setFromCenterAndSize(center, extent);
        const delta = (plane - center.dot(normal)) / normal.getComponent(axis);
        projected.copy(center).setComponent(axis, center.getComponent(axis) + delta);
        // Centre mode rasterizes the dominant-axis voxel centres, then assigns one cell along depth.
        const hit =
          mode === 'conservative'
            ? cell.intersectsTriangle(triangle)
            : withinGrid(Math.floor(boundary(projected.getComponent(axis)))) === [x, y, z][axis] &&
              triangle.containsPoint(projected);
        candidates.push({ center, hit });
      }
    }
  }
  const box = new Box3(
    new Vector3(...(min as [number, number, number])).multiplyScalar(size).subScalar(HALF),
    new Vector3(...(max as [number, number, number]))
      .addScalar(1)
      .multiplyScalar(size)
      .subScalar(HALF)
  );
  return { axis, box, candidates, vertices };
}
