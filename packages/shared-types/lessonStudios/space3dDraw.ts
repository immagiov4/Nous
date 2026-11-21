import type { Material, Object3D, Side, Texture } from 'three';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  EdgesGeometry,
  Float32BufferAttribute,
  type Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Vector3,
} from 'three';

export interface Space3dColors {
  ink: string;
  surface: string;
  accent: string;
  near: string;
  far: string;
  empty: string;
}

// Colors affect paint only. Browser callers can supply the resolved lesson scene tokens.
const defaults: Space3dColors = {
  ink: '#222322',
  surface: '#fffefa',
  accent: '#b64c2f',
  near: '#3779a8',
  far: '#8c598c',
  empty: '#748644',
};
export function space3dPalette(colors: Space3dColors = defaults) {
  return {
    ink: new Color(colors.ink || defaults.ink),
    surface: new Color(colors.surface || defaults.surface),
    accent: new Color(colors.accent || defaults.accent),
    near: new Color(colors.near || defaults.near),
    far: new Color(colors.far || defaults.far),
    empty: new Color(colors.empty || defaults.empty),
  };
}

export type Palette = ReturnType<typeof space3dPalette>;
const boxGeometry = new BoxGeometry();
const squarePositions = new EdgesGeometry(boxGeometry).getAttribute('position');

export function placeOpacity(object: Object3D, opacity: number) {
  object.visible = opacity > 0.001;
  if (!object.visible) return;
  object.traverse(node => {
    const material = (node as Mesh<BufferGeometry, Material>).material;
    if (!material) return;
    material.userData.strength ??= material.opacity;
    material.opacity = material.userData.strength * opacity;
  });
}

export function lit(color: Color, opacity = 1) {
  return new MeshLambertMaterial({ color, opacity, transparent: true });
}

export function cubes(parent: Group, capacity: number, color: Color, opacity = 1, flat = false) {
  const material = flat
    ? new MeshBasicMaterial({ color, transparent: true, opacity })
    : lit(color, opacity);
  const mesh = new InstancedMesh(boxGeometry, material, Math.max(1, capacity));
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  if (opacity < 1) material.depthWrite = false;
  parent.add(mesh);
  const matrix = new Matrix4();
  return {
    mesh,
    at(index: number, point: Vector3, size: number, color?: Color, depth = size) {
      mesh.setMatrixAt(index, matrix.makeScale(size, size, depth).setPosition(point));
      if (color) mesh.setColorAt(index, color);
    },
    finish(count: number) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}

export function lines(parent: Group, points: Vector3[], color: Color, opacity: number) {
  const mesh = new LineSegments(
    new BufferGeometry().setFromPoints(points),
    new LineBasicMaterial({
      color,
      opacity,
      transparent: true,
      depthWrite: false,
    })
  );
  parent.add(mesh);
  return mesh;
}

export function wireBox(parent: Group, color: Color, opacity: number) {
  const wire = new LineSegments(
    new EdgesGeometry(boxGeometry),
    new LineBasicMaterial({
      color,
      opacity,
      transparent: true,
      depthWrite: false,
    })
  );
  parent.add(wire);
  return wire;
}

export function wireBatch(parent: Group, capacity: number, color: Color, opacity: number) {
  const wire = lines(parent, [], color, opacity);
  const positions = new Float32BufferAttribute(
    new Float32Array(capacity * squarePositions.count * 3),
    3
  );
  positions.setUsage(DynamicDrawUsage);
  wire.geometry.setAttribute('position', positions);
  wire.frustumCulled = false;
  wire.geometry.setDrawRange(0, 0);
  return {
    at(index: number, center: Vector3, size: number) {
      for (let i = 0; i < squarePositions.count; i++) {
        positions.setXYZ(
          index * squarePositions.count + i,
          center.x + size * squarePositions.getX(i),
          center.y + size * squarePositions.getY(i),
          center.z + size * squarePositions.getZ(i)
        );
      }
    },
    finish(count: number) {
      wire.geometry.setDrawRange(0, count * squarePositions.count);
      positions.needsUpdate = true;
    },
  };
}

export function polyline(parent: Group, points: Vector3[], color: Color, opacity: number) {
  const line = new Line(
    new BufferGeometry().setFromPoints(points),
    new LineBasicMaterial({
      color,
      opacity,
      transparent: true,
      depthWrite: false,
    })
  );
  line.frustumCulled = false;
  parent.add(line);
  return line;
}

export function moveVertices(object: Line | Mesh, points: Vector3[]) {
  const positions = object.geometry.getAttribute('position');
  for (const [i, point] of points.entries()) positions.setXYZ(i, point.x, point.y, point.z);
  positions.needsUpdate = true;
}

export function triangleMesh(
  parent: Group,
  vertices: Vector3[],
  color: Color,
  opacity: number,
  side: Side = DoubleSide
) {
  const surface = new Mesh(
    new BufferGeometry().setFromPoints(vertices),
    new MeshBasicMaterial({
      color,
      side,
      opacity,
      transparent: true,
      depthWrite: false,
    })
  );
  surface.frustumCulled = false;
  parent.add(surface);
  const edge = polyline(parent, [...vertices, vertices[0]], color, 1);
  return (points: Vector3[]) => {
    moveVertices(surface, points);
    moveVertices(edge, [...points, points[0]]);
  };
}

export function disposeSpace3dMeshes(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse(node => {
    if (node instanceof InstancedMesh) node.dispose();
    if (node instanceof Mesh || node instanceof Line) {
      if (node.geometry !== boxGeometry) geometries.add(node.geometry);
      const paint: Material | Material[] = node.material;
      for (const material of Array.isArray(paint) ? paint : [paint]) materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  const textures = new Set<Texture>();
  for (const material of materials) {
    if (material instanceof MeshBasicMaterial && material.map) textures.add(material.map);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}
