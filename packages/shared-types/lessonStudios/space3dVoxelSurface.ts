import { Group, Vector3 } from 'three';
import type { Palette } from './space3dDraw';
import { cubes, lines, triangleMesh, wireBox } from './space3dDraw';
import { HALF, trianglesOf, voxelize } from './space3dMath';
import type { Spec } from './space3dSpec';

export function surfaceLayer(group: Group, spec: Spec, colors: Palette) {
  const data = trianglesOf(spec.triangles!).map(triangle => voxelize(triangle, spec.n, spec.mode));
  const model = new Group(),
    projection = new Group();
  group.add(model, projection);
  const size = 1 / spec.n;
  const occupied = new Set<string>();
  const traces = data.map(({ box, axis, vertices, candidates }, index) => {
    const color = [colors.near, colors.far, colors.empty][index];
    triangleMesh(model, vertices, color, 0.23);
    const bounds = wireBox(model, color, 0.68);
    box.getCenter(bounds.position);
    box.getSize(bounds.scale);
    const [u, v] = [0, 1, 2].filter(component => component !== axis);
    const toPlane = (point: Vector3) =>
      new Vector3(point.getComponent(u), point.getComponent(v), index * 0.012);
    const projectedTriangle = new Group();
    projection.add(projectedTriangle);
    triangleMesh(projectedTriangle, vertices.map(toPlane), color, 0.34);
    const grid: Vector3[] = [];
    for (let i = 0; i <= spec.n; i++) {
      const at = i * size - HALF;
      grid.push(
        new Vector3(at, -HALF, 0),
        new Vector3(at, HALF, 0),
        new Vector3(-HALF, at, 0),
        new Vector3(HALF, at, 0)
      );
    }
    if (index === 0) lines(projection, grid, colors.ink, 0.17).renderOrder = -1;
    const cells = cubes(model, candidates.filter(cell => cell.hit).length, colors.accent);
    const pixels = cubes(
      projectedTriangle,
      candidates.filter(cell => cell.hit).length,
      colors.accent,
      1,
      true
    );
    const active = wireBox(model, colors.ink, 1);
    active.scale.setScalar(size);
    let count = 0;
    const seen = new Set<string>();
    const detected = candidates.map(cell => {
      if (!cell.hit) return { count, projected: seen.size };
      const voxelKey = cell.center.toArray().join(',');
      if (!occupied.has(voxelKey)) cells.at(count++, cell.center, size * 0.9);
      occupied.add(voxelKey);
      const target = toPlane(cell.center);
      const key = `${target.x},${target.y}`;
      if (!seen.has(key)) pixels.at(seen.size, target, size, undefined, 0.001);
      seen.add(key);
      return { count, projected: seen.size };
    });
    cells.finish(count);
    cells.mesh.count = 0;
    pixels.finish(seen.size);
    pixels.mesh.count = 0;
    return {
      cells,
      pixels,
      projectedTriangle,
      active,
      axis,
      candidates,
      detected,
      center: bounds.position,
    };
  });
  const total = traces.reduce((sum, trace) => sum + trace.candidates.length, 0);
  let drawn = -1;
  let hit = 0,
    axis = traces[0].axis;
  const focus = new Vector3();
  function draw(progress: number, project: number) {
    projection.visible = project > 0;
    projection.scale.setScalar(project);
    projection.position.set(0.59 * project, 0.01, 0);
    model.position.x = -0.55 * project;
    const tested = Math.min(total, Math.round(progress * total));
    if (tested !== drawn) {
      drawn = tested;
      let offset = 0;
      hit = 0;
      let current = traces[0];
      for (const trace of traces) {
        const count = Math.max(0, Math.min(trace.candidates.length, tested - offset));
        const found = trace.detected[count - 1];
        trace.cells.mesh.count = found?.count ?? 0;
        trace.pixels.mesh.count = found?.projected ?? 0;
        trace.active.visible =
          tested < total && tested >= offset && count < trace.candidates.length;
        if (trace.active.visible) trace.active.position.copy(trace.candidates[count].center);
        if (tested >= offset) current = trace;
        hit += found?.count ?? 0;
        offset += trace.candidates.length;
      }
      axis = current.axis;
      for (const trace of traces) trace.projectedTriangle.visible = trace === current;
    }
    const active = traces.find(trace => trace.active.visible);
    focus.copy(active?.active.position ?? traces[0].center).add(model.position);
    if (project > 0.5) focus.copy(projection.position);
    return { hit, tested, total, axis, focus };
  }
  return { draw };
}
