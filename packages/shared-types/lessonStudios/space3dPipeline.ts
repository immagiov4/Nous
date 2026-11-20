import { Group, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, SphereGeometry, Vector3, Vector4 } from "three";
import { cubes, lines, triangleMesh, wireBox } from "./space3dDraw";
import type { Palette } from "./space3dDraw";
import { trianglesOf } from "./space3dMath";
import type { Spec } from "./space3dSpec";

const rows = 12;
const columns = 20;
const pitch = 0.087;
const viewportWidth = columns * pitch;
const viewportHeight = rows * pitch;
const first = new Vector3();

function transform(spec: Spec) {
  const model = new Matrix4().makeRotationY(0.21).setPosition(0.08, 0.04, 0);
  const camera = new PerspectiveCamera(44, columns / rows, 0.5, 4);
  camera.position.set(0.22, 0.11, 1.49);
  camera.lookAt(first);
  camera.updateMatrixWorld(true);

  return trianglesOf(spec.triangles!).map(({ a, b, c }) => {
    const local = [a, b, c];
    const view = local.map(point => point.clone().applyMatrix4(model).applyMatrix4(camera.matrixWorldInverse));
    const clip = view.map(point => new Vector4(point.x, point.y, point.z, 1).applyMatrix4(camera.projectionMatrix));
    const ndc = clip.map(point => new Vector3(point.x / point.w, point.y / point.w, point.z / point.w));
    return { local, view, clip, ndc };
  }).map(points => ({ ...points, camera }));
}

function viewport(point: Vector3) {
  return new Vector3(point.x * viewportWidth / 2, point.y * viewportHeight / 2, 0);
}

function sample(triangle: ReturnType<typeof transform>[number], x: number, y: number) {
  const [a, b, c] = triangle.ndc;
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (!denominator) return null;
  const u = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator;
  const v = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator;
  const w = 1 - u - v;
  if (Math.min(u, v, w) < 0) return null;
  const depth = (1 + u * a.z + v * b.z + w * c.z) / 2;
  return depth >= 0 && depth <= 1 ? depth : null;
}

export function rasterize(spec: Spec) {
  const triangles = transform(spec);
  const pixels = [];
  for (let y = rows - 1; y >= 0; y--) {
    for (let x = 0; x < columns; x++) {
      const probe = new Vector3(2 * (x + 0.5) / columns - 1, 2 * (y + 0.5) / rows - 1, 0);
      const [prior, incoming] = triangles.map(triangle => sample(triangle, probe.x, probe.y));
      if (prior === null && incoming === null) continue;
      pixels.push({ probe, prior, incoming, winner: incoming !== null && (prior === null || incoming < prior) ? 1 : 0 });
    }
  }
  return { triangles, pixels };
}

export function pipelineLayer(group: Group, spec: Spec, colors: Palette) {
  const { triangles, pixels } = rasterize(spec);
  const camera = triangles[0].camera;
  const viewOffset = new Vector3(0, 0, Math.hypot(...camera.position.toArray()));
  const stagePoints = triangles.map(({ local, view, clip, ndc }) => [
    local,
    view.map(point => point.clone().add(viewOffset)),
    clip.map(point => viewport(new Vector3(point.x, point.y, 0))),
    ndc.map(viewport),
  ]);
  const subjects = new Group(), background = new Group(), raster = new Group(), incomingOutline = new Group();
  group.add(background, subjects, raster, incomingOutline);
  const firstTriangle = triangleMesh(subjects, stagePoints[0][0], colors.near, 0.40);
  const secondTriangle = triangleMesh(incomingOutline, stagePoints[1][0], colors.far, 0.14);
  const cameraDiagram = new Group();
  group.add(cameraDiagram);
  const frustum = (fromClip: (point: Vector3) => Vector3, eye: Vector3) => {
    const corners = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => fromClip(new Vector3(x,y,-1)));
    return corners.flatMap((corner, i) => [corner, corners[(i + 1) % corners.length], eye, corner]);
  };
  const modelFrustum = frustum(point => point.unproject(camera), camera.position);
  const viewFrustum = frustum(point => point.applyMatrix4(camera.projectionMatrixInverse).add(viewOffset), viewOffset);
  const frame = lines(cameraDiagram, modelFrustum, colors.ink, 0.72);
  const eye = new Mesh(new SphereGeometry(0.035, 12, 8), new MeshBasicMaterial({ color: colors.ink }));
  cameraDiagram.add(eye);
  const farther = stagePoints[0][1].map(point => point.clone().add(new Vector3(0.48, 0.25, -0.76)));
  const fartherClip = farther.map(point => {
    const view = point.clone().sub(viewOffset);
    return new Vector4(view.x, view.y, view.z, 1).applyMatrix4(camera.projectionMatrix);
  });
  const fartherPositions = [farther, farther, fartherClip.map(p => viewport(new Vector3(p.x, p.y, 0))),
    fartherClip.map(p => viewport(new Vector3(p.x / p.w, p.y / p.w, 0)))];
  const distanceExample = new Group();
  group.add(distanceExample);
  const fartherTriangle = triangleMesh(distanceExample, farther, colors.far, 0.26);
  const basis = new Group();
  group.add(basis);
  const axes = [new Vector3(0.52, 0, 0), new Vector3(0, 0.42, 0), new Vector3(0, 0, -0.42)];
  axes.forEach((axis, i) => lines(basis, [axis.clone().multiplyScalar(-1), axis],
    [colors.accent, colors.near, colors.far][i], 0.44));
  const vertexMarker = new Mesh(new SphereGeometry(0.014, 12, 8), new MeshBasicMaterial({ color: colors.accent }));
  group.add(vertexMarker);
  const grid: Vector3[] = [];
  for (let x = 0; x <= columns; x++) {
    const at = x * pitch - viewportWidth / 2;
    grid.push(new Vector3(at, -viewportHeight / 2, 0), new Vector3(at, viewportHeight / 2, 0));
  }
  for (let y = 0; y <= rows; y++) {
    const at = y * pitch - viewportHeight / 2;
    grid.push(new Vector3(-viewportWidth / 2, at, 0), new Vector3(viewportWidth / 2, at, 0));
  }
  lines(background, grid, colors.ink, 0.17).renderOrder = -1;
  const outputs = [colors.near, colors.far].map(color => cubes(raster, pixels.length, color, 1, true));
  const probeBorder = wireBox(raster, colors.accent, 1);
  probeBorder.scale.setScalar(pitch);
  probeBorder.material.depthTest = false;
  probeBorder.renderOrder = 3;
  const pick = (overlap: boolean) =>
    pixels.filter(pixel => !overlap || (pixel.prior !== null && pixel.incoming !== null))
      .reduce<typeof pixels[number] | undefined>((central, pixel) =>
        !central || pixel.probe.lengthSq() < central.probe.lengthSq() ? pixel : central, undefined);
  const selected = pick(true) ?? pick(false);
  const fragments = pixels.filter(pixel => pixel.prior !== null).length;
  const compareOrder = selected ? [selected, ...pixels.filter(pixel => pixel !== selected)] : pixels;
  const focus = new Vector3();
  let written = 0;
  let lastCount = -1, lastDepth = false;
  function draw(phase: number) {
    const lower = Math.min(3, Math.floor(phase));
    const upper = Math.min(3, lower + 1);
    const fraction = Math.min(1, phase - lower);
    const positions = (index: number) => stagePoints[index][lower].map((point, vertex) =>
      point.clone().lerp(stagePoints[index][upper][vertex], fraction));
    const pose = positions(0);
    firstTriangle(pose);
    cameraDiagram.visible = phase < 2;
    const viewMix = Math.min(1, phase);
    const framePositions = frame.geometry.getAttribute("position");
    for (const [i, p] of modelFrustum.entries()) {
      const vertex = p.clone().lerp(viewFrustum[i], viewMix);
      framePositions.setXYZ(i, vertex.x, vertex.y, vertex.z);
    }
    framePositions.needsUpdate = true;
    frame.frustumCulled = false;
    frame.material.opacity = 0.72 * Math.min(1, 2 - phase);
    eye.position.copy(camera.position).lerp(viewOffset, viewMix);
    distanceExample.visible = phase < 4;
    if (distanceExample.visible) fartherTriangle(fartherPositions[lower].map((point, i) =>
      point.clone().lerp(fartherPositions[upper][i], fraction)));
    basis.visible = phase < 2;
    basis.scale.setScalar(Math.max(0.001, 1 - Math.max(0, phase - 1)));
    vertexMarker.visible = phase < 4;
    vertexMarker.position.copy(pose[1]);
    secondTriangle(positions(1));
    const rasterAmount = Math.max(0, Math.min(1, phase - 3));
    const depthAmount = Math.max(0, phase - 4);
    background.scale.setScalar(Math.max(0.001, rasterAmount));
    background.visible = rasterAmount > 0;
    incomingOutline.visible = depthAmount > 0;
    incomingOutline.position.z = 0.005;
    const count = Math.round(pixels.length * (phase <= 4 ? rasterAmount : depthAmount));
    const depth = phase > 4;
    if (count !== lastCount || depth !== lastDepth) {
      lastCount = count;
      lastDepth = depth;
      const booked = [0, 0];
      for (const [index, pixel] of (depth ? compareOrder : pixels).entries()) {
        const winner = depth && index < count ? pixel.winner : pixel.prior !== null ? 0 : null;
        if ((!depth && index >= count) || winner === null) continue;
        outputs[winner].at(booked[winner]++, viewport(pixel.probe), pitch * 0.91, undefined, 0.001);
      }
      outputs.forEach((output, index) => output.finish(booked[index]));
      written = booked[0] + booked[1];
    }
    probeBorder.visible = Boolean(selected && depth);
    if (selected && depth) probeBorder.position.copy(viewport(selected.probe)).setZ(0.03);
    focus.copy(depth && selected ? probeBorder.position : pose[1]);
    const vertex = triangles[0];
    return { focus, count, sample: selected, local: vertex.local[1], view: vertex.view[1],
      clip: vertex.clip[1], ndc: vertex.ndc[1], fragments, written };
  }
  return { draw };
}
