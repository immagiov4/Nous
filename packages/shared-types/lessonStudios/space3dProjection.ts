import type { BufferGeometry, Material, Object3D, PerspectiveCamera, Scene } from 'three';
import { Box3, Matrix4, Vector3 } from 'three';
import { chartViewport, WIDTH } from './chartDimensions';
import type { LayoutBounds } from './layoutValidation';
import type { Point } from './vectorScene';

const corners = [0, 1, 2, 3, 4, 5, 6, 7];
const projectionInset = 0.97;

type MeshBounds = {
  version: string;
  box: Box3;
};

function toScreen(point: Vector3): Point {
  return [
    ((point.x + 1) * WIDTH) / 2,
    chartViewport.top + ((1 - point.y) * chartViewport.height) / 2,
  ];
}

type Drawable = Object3D & { geometry?: BufferGeometry; material?: Material };

export function space3dProjection(scene: Scene, camera: PerspectiveCamera) {
  const cached = new WeakMap<BufferGeometry, MeshBounds>();
  const vertex = new Vector3();
  const instanceMatrix = new Matrix4();
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

  function fit(): LayoutBounds[] {
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    const projected: LayoutBounds[] = [];
    let extent = projectionInset;
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
          .project(camera);
        const [x, y] = toScreen(vertex);
        bounds.left = Math.min(bounds.left, x);
        bounds.top = Math.min(bounds.top, y);
        bounds.right = Math.max(bounds.right, x);
        bounds.bottom = Math.max(bounds.bottom, y);
        extent = Math.max(extent, Math.abs(vertex.x), Math.abs(vertex.y));
      }
      projected.push(bounds);
    });
    // Adjust the lens and the inspected coordinates together, without cropping the current mechanism.
    const scale = projectionInset / extent;
    camera.projectionMatrix.premultiply(instanceMatrix.makeScale(scale, scale, 1));
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    return projected.map(({ left, top, right, bottom }) => ({
      left: WIDTH / 2 + (left - WIDTH / 2) * scale,
      right: WIDTH / 2 + (right - WIDTH / 2) * scale,
      top:
        chartViewport.top +
        chartViewport.height / 2 +
        (top - (chartViewport.top + chartViewport.height / 2)) * scale,
      bottom:
        chartViewport.top +
        chartViewport.height / 2 +
        (bottom - (chartViewport.top + chartViewport.height / 2)) * scale,
    }));
  }

  return { fit, project: (point: Vector3) => toScreen(vertex.copy(point).project(camera)) };
}
