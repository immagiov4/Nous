import type { BufferGeometry, Material, Object3D, PerspectiveCamera, Scene } from 'three';
import { Box3, Matrix4, Vector3 } from 'three';
import type { StudioViewport } from './chartDimensions';
import type { LayoutBounds } from './layoutValidation';
import type { Point } from './vectorScene';

const corners = [0, 1, 2, 3, 4, 5, 6, 7];
const projectionInset = 0.97;

type MeshBounds = {
  version: string;
  box: Box3;
};

type Drawable = Object3D & { geometry?: BufferGeometry; material?: Material };

export function space3dProjection(
  scene: Scene,
  camera: PerspectiveCamera,
  { width, height }: StudioViewport
) {
  const centerX = width / 2;
  const centerY = height / 2;
  const toScreen = (point: Vector3): Point => [(point.x + 1) * centerX, (1 - point.y) * centerY];
  const cached = new WeakMap<BufferGeometry, MeshBounds>();
  const vertex = new Vector3();
  const instanceMatrix = new Matrix4();
  const fitMatrix = new Matrix4();
  const instanceBounds = new Box3();
  const combined = new Box3();

  function geometryBounds(geometry: BufferGeometry) {
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const { start, count } = geometry.drawRange;
    const version = [
      start,
      count,
      'version' in position ? position.version : position.data.version,
    ].join('/');
    const prior = cached.get(geometry);
    if (prior?.version === version) return prior.box;
    const box = new Box3();
    const stop = Math.min(start + count, index?.count ?? position.count);
    for (let i = start; i < stop; i++) {
      vertex.fromBufferAttribute(position, index ? index.getX(i) : i);
      box.expandByPoint(vertex);
    }
    cached.set(geometry, { version, box });
    return box;
  }

  const instances = new WeakMap<Object3D, MeshBounds>();
  function boundsOf(node: Drawable, box: Box3) {
    if (!('isInstancedMesh' in node)) return box;
    const mesh = node as import('three').InstancedMesh;
    const version = [mesh.count, mesh.instanceMatrix.version].join('/');
    const previous = instances.get(mesh);
    if (previous?.version === version) return previous.box;
    combined.makeEmpty();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, instanceMatrix);
      combined.union(instanceBounds.copy(box).applyMatrix4(instanceMatrix));
    }
    const result = combined.clone();
    instances.set(mesh, { version, box: result });
    return result;
  }

  function fit(area: LayoutBounds): LayoutBounds[] {
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    const projected: LayoutBounds[] = [];
    const total = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    scene.traverseVisible((node: Drawable) => {
      if (!node.geometry || (node.material?.opacity ?? 1) <= 0.01) return;
      const box = boundsOf(node, geometryBounds(node.geometry));
      if (box.isEmpty()) return;
      const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (const bits of corners) {
        vertex
          .set(
            bits & 1 ? box.max.x : box.min.x,
            bits & 2 ? box.max.y : box.min.y,
            bits & 4 ? box.max.z : box.min.z
          )
          .applyMatrix4(node.matrixWorld)
          .applyMatrix4(camera.matrixWorldInverse);
        if (vertex.z >= 0) continue;
        vertex.applyMatrix4(camera.projectionMatrix);
        const [x, y] = toScreen(vertex);
        bounds.left = Math.min(bounds.left, x);
        bounds.top = Math.min(bounds.top, y);
        bounds.right = Math.max(bounds.right, x);
        bounds.bottom = Math.max(bounds.bottom, y);
      }
      if (!Number.isFinite(bounds.left)) return;
      total.left = Math.min(total.left, bounds.left);
      total.right = Math.max(total.right, bounds.right);
      total.top = Math.min(total.top, bounds.top);
      total.bottom = Math.max(total.bottom, bounds.bottom);
      projected.push(bounds);
    });
    if (!projected.length) return projected;
    const scale = Math.min(
      1,
      (projectionInset * (area.right - area.left)) / (total.right - total.left),
      (projectionInset * (area.bottom - area.top)) / (total.bottom - total.top)
    );
    const offset = (low: number, high: number, min: number, max: number, center: number) =>
      Math.max(
        min - center - (low - center) * scale,
        Math.min(0, max - center - (high - center) * scale)
      );
    const dx = offset(total.left, total.right, area.left, area.right, centerX);
    const dy = offset(total.top, total.bottom, area.top, area.bottom, centerY);
    // Keep the inspected pixel bounds and WebGL lens on the same transform.
    fitMatrix.makeScale(scale, scale, 1).setPosition(dx / centerX, -dy / centerY, 0);
    camera.projectionMatrix.premultiply(fitMatrix);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    return projected.map(({ left, top, right, bottom }) => ({
      left: centerX + (left - centerX) * scale + dx,
      right: centerX + (right - centerX) * scale + dx,
      top: centerY + (top - centerY) * scale + dy,
      bottom: centerY + (bottom - centerY) * scale + dy,
    }));
  }

  return { fit, project: (point: Vector3) => toScreen(vertex.copy(point).project(camera)) };
}
