import { Color, ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Ray, Vector3 } from "three";
import { MarchingCubes } from "three/addons/objects/MarchingCubes.js";
import { cubes, lines, lit, wireBatch, wireBox } from "./space3dDraw";
import type { Palette } from "./space3dDraw";
import { HALF, octree, sampleSolid, sdf, traverse } from "./space3dMath";
import type { Node, Visit } from "./space3dMath";
import type { Spec } from "./space3dSpec";

export function shapeLayer(group: Group, shape: NonNullable<Spec["shape"]>, colors: Palette) {
  const resolution = 40;
  const surface = new MarchingCubes(resolution, lit(colors.accent), false, false, 24_000);
  surface.isolation = 0;
  for (let z = 0; z < resolution; z++) {
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        surface.field[x + resolution * (y + resolution * z)] =
          -sdf(shape, x / resolution - HALF, y / resolution - HALF, z / resolution - HALF);
      }
    }
  }
  surface.scale.setScalar(HALF);
  surface.update();
  group.add(surface);
  wireBox(group, colors.ink, 0.22);
}

export function denseLayer(group: Group, spec: Spec, colors: Palette) {
  const samples = sampleSolid(spec.shape!, spec.n);
  const voxels = cubes(group, samples.length, colors.accent);
  const edges = wireBatch(group, samples.length, colors.ink, 0.20);
  for (const [index, center] of samples.entries()) {
    voxels.at(index, center, 0.91 / spec.n);
    edges.at(index, center, 0.913 / spec.n);
  }
  voxels.finish(samples.length);
  edges.finish(samples.length);
  if (spec.wire) {
    const edges: Vector3[] = [];
    for (const axis of [0, 1, 2]) {
      for (let i = 0; i <= spec.n; i++) {
        for (let j = 0; j <= spec.n; j++) {
          const point = new Vector3().setComponent(axis, -HALF)
            .setComponent((axis + 1) % 3, i / spec.n - HALF).setComponent((axis + 2) % 3, j / spec.n - HALF);
          edges.push(point, point.clone().setComponent(axis, HALF));
        }
      }
    }
    lines(group, edges, colors.ink, 0.09);
  } else wireBox(group, colors.ink, 0.22);
  return samples.length;
}

type Leaf = { node: Node; parent: Node };
function cut(root: Node, depth: number) {
  const occupied: Leaf[] = [], empty: Leaf[] = [];
  let nodes = 0;
  function visit(node: Node, parent: Node) {
    nodes++;
    if (node.level === depth || !node.children.length) {
      (node.occupied ? occupied : empty).push({ node, parent });
    } else node.children.forEach(child => visit(child, node));
  }
  visit(root, root);
  return { occupied, empty, nodes };
}

export function treeLayer(group: Group, spec: Spec, colors: Palette) {
  const resolution = 2 ** spec.maxDepth;
  const root = octree(sampleSolid(spec.shape!, resolution), spec.maxDepth);
  const cuts = Array.from({ length: spec.maxDepth + 1 }, (_, depth) => cut(root, depth));
  const full = cuts.at(-1)!;
  const occupied = cubes(group, full.occupied.length, colors.accent);
  const empty = cubes(group, full.empty.length, colors.empty, 0.035, true);
  const emptyEdges = wireBatch(group, full.empty.length, colors.empty, 0.47);
  const fullEdges = wireBatch(group, full.occupied.length, colors.ink, 0.25);
  const closeBranch = !spec.layers.includes("ray") ? cuts
    .flatMap(cut => cut.occupied.map(item => item.node))
    .find(node => node.level > 0 && node.children.some(child => child.occupied) &&
      node.children.some(child => !child.occupied)) : undefined;
  const branchCuts = closeBranch ? cuts.map((_, level) => cut(closeBranch, Math.max(closeBranch.level, level))) : [];
  const outline = closeBranch ? wireBox(group, colors.near, 0.82) : undefined;
  const point = new Vector3(), local = new Vector3();
  let previous = -1, previousInspection = -1;
  function draw(depth: number, inspection = 0) {
    const level = Math.ceil(depth);
    const chosen = cuts[level];
    const zoom = closeBranch ? Math.max(0, Math.min(1, depth - closeBranch.level)) : 0;
    if (previous === depth && previousInspection === inspection) return chosen;
    previous = depth;
    previousInspection = inspection;
    const localCut = closeBranch && zoom > 0.46 ? branchCuts[level] : chosen;
    const insetScale = closeBranch ? 1 + (.78 / closeBranch.size - 1) * zoom : 1;
    function place(node: Node, parent: Node) {
      const spread = Math.sin(Math.PI * (level - depth)) * 0.22;
      point.copy(node.center).lerp(parent.center, node.level === level ? -spread : 0);
      if (closeBranch) point.addScaledVector(closeBranch.center, -zoom);
      return point.multiplyScalar(insetScale);
    }
    for (const [index, { node, parent }] of localCut.occupied.entries()) {
      const center = place(node, parent);
      occupied.at(index, center, node.size * insetScale * 0.9);
      fullEdges.at(index, center, node.size * insetScale * 0.903);
    }
    for (const [index, { node, parent }] of localCut.empty.entries()) {
      const center = place(node, parent);
      empty.at(index, center, node.size * insetScale * 0.96);
      emptyEdges.at(index, center, node.size * insetScale * 0.97);
    }
    if (outline && closeBranch) {
      const target = inspection === 1 ? closeBranch.children.find(child => child.children.length)
        : inspection > 1 ? closeBranch.children.find(child => !child.occupied) : closeBranch;
      outline.visible = zoom > 0.46 && Boolean(target);
      if (target) {
        local.copy(target.center).addScaledVector(closeBranch.center, -zoom).multiplyScalar(insetScale);
        outline.position.copy(local);
        outline.scale.setScalar(target.size * insetScale * 1.035);
      }
    }
    occupied.finish(localCut.occupied.length);
    fullEdges.finish(localCut.occupied.length);
    empty.finish(localCut.empty.length);
    emptyEdges.finish(localCut.empty.length);
    return chosen;
  }
  return { root, draw, cuts, closeBranch, total: resolution ** 3 };
}

export function rayLayer(group: Group, spec: Spec, colors: Palette, root: Node) {
  const { origin, direction } = spec.ray!;
  const ray = new Ray(new Vector3(...origin), new Vector3(...direction).normalize());
  const paths = Array.from({ length: spec.maxDepth + 1 }, (_, depth) => traverse(root, ray, depth));
  const halfLength = 0.82;
  // Keep the displayed beam within the framing while preserving its direction and actual entry point.
  const span = paths[0][0];
  const start = span ? Math.max(0, span.enter - 0.25) : Math.max(0, -ray.origin.dot(ray.direction) - halfLength);
  const end = span ? span.exit + 0.23 : start + 2 * halfLength;
  const beamMaterial = new MeshBasicMaterial({
    color: colors.near, depthTest: false, depthWrite: false, transparent: true,
  });
  const beam = new Mesh(new CylinderGeometry(0.006, 0.006, 1, 8), beamMaterial);
  const headMesh = new Mesh(new ConeGeometry(0.014, 1, 12), beamMaterial);
  beam.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), ray.direction);
  headMesh.quaternion.copy(beam.quaternion);
  beam.renderOrder = headMesh.renderOrder = 5;
  group.add(beam, headMesh);
  const focus = wireBox(group, colors.near, 1);
  focus.material.depthTest = false;
  focus.renderOrder = 5;
  const tint = cubes(group, Math.max(...paths.map(path => path.length)), new Color("white"), 0.32, true);
  tint.mesh.material.depthTest = false;
  const byKind = { skip: colors.empty, descend: colors.near, hit: colors.accent };
  const tip = new Vector3();
  let previousPath: Visit[] | undefined, previousIndex = -1;
  function draw(depth: number, progress: number) {
    const path = paths[Math.ceil(depth)];
    const position = progress * path.length;
    const index = Math.min(path.length - 1, Math.floor(position));
    const current = path[index];
    if (previousPath !== path || previousIndex !== index) {
      previousPath = path;
      previousIndex = index;
      focus.visible = Boolean(current);
      if (current) {
        focus.position.copy(current.node.center);
        focus.scale.setScalar(current.node.size * 1.022);
        focus.material.color.copy(byKind[current.kind]);
      }
      let count = 0;
      for (const visit of path.slice(0, index + 1)) {
        if (visit.kind === "descend") continue;
        tint.at(count++, visit.node.center, visit.node.size * 1.01, byKind[visit.kind]);
      }
      tint.finish(count);
    }
    // Internal nodes point to entry. A skip or hit moves the arrow through that leaf's interval.
    const amount = current ? current.enter + (current.kind === "descend" ? 0 :
      (current.exit - current.enter) * (progress === 1 ? 1 : position % 1)) : start + (end - start) * progress;
    const length = Math.max(0.002, amount - start);
    const head = Math.min(0.045, length);
    headMesh.scale.y = head;
    ray.at(start + length - head / 2, headMesh.position);
    beam.scale.y = length - head / 2;
    ray.at(start + beam.scale.y / 2, beam.position);
    return { tip: ray.at(amount, tip), current, tests: index + 1,
      skips: path.slice(0, index + 1).filter(visit => visit.kind === "skip").length };
  }
  return { draw };
}
