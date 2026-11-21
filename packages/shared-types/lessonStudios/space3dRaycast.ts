import type { Group } from 'three';
import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Ray,
  Sphere,
  SphereGeometry,
  Vector3,
} from 'three';
import { textAt } from './chart';
import { DIM } from './motion';
import { copy, cosine, rayNormal } from './space3dCopy.it';
import type { Palette } from './space3dDraw';
import { lines, lit, moveVertices, polyline } from './space3dDraw';
import { moveOverlay } from './space3dOverlay';
import type { Beat, Space3dSpec } from './space3dSpec';
import { svg, type VectorNode } from './vectorScene';

const camera = new Vector3(-1.33, 0.06, 0.12);
const imageX = -0.78;
const imageSpan = 0.66;
const legacyImageX = -0.85;
const legacySpan = 0.54;
const cameraDistance = 2.28;
const floorSize = 1.72;
const groundX = 0.19;
const epsilon = 1e-6;
type RaySpec = NonNullable<Space3dSpec['raycast']>;
type Hit = { object: number; point: Vector3; distance: number; normal: Vector3 };

function boxNormal(box: Box3, point: Vector3) {
  const q = point.clone().sub(box.getCenter(new Vector3()));
  const axis = q
    .toArray()
    .map(Math.abs)
    .indexOf(Math.max(Math.abs(q.x), Math.abs(q.y), Math.abs(q.z)));
  return new Vector3().setComponent(axis, Math.sign(q.getComponent(axis)));
}

function rayScene(spec: RaySpec) {
  const light = new Vector3(...spec.light);
  const objects = spec.objects.map(object => {
    const center = new Vector3(...object.at);
    if (object.kind === 'sphere') return new Sphere(center, object.radius);
    const size = new Vector3().setScalar(object.size);
    return new Box3().setFromCenterAndSize(center, size);
  });
  const floorIndex = objects.length;
  const up = new Vector3(0, 1, 0);
  const height = spec.ground;

  function hits(ray: Ray): Hit[] {
    const results = objects.flatMap((body, object) => {
      const point =
        body instanceof Sphere
          ? ray.intersectSphere(body, new Vector3())
          : ray.intersectBox(body, new Vector3());
      if (!point) return [];
      const normal =
        body instanceof Sphere
          ? point.clone().sub(body.center).normalize()
          : boxNormal(body, point);
      return [{ object, point, distance: point.distanceTo(ray.origin), normal }];
    });
    if (height !== undefined && ray.direction.y < 0) {
      const distance = (height - ray.origin.y) / ray.direction.y;
      const point = ray.at(distance, new Vector3());
      if (
        distance > epsilon &&
        Math.max(Math.abs(point.x - groundX), Math.abs(point.z)) <= floorSize / 2
      ) {
        results.push({ object: floorIndex, point, distance, normal: up });
      }
    }
    return results.sort((a, b) => a.distance - b.distance);
  }

  function shade(hit: Hit) {
    const towardLight = light.clone().sub(hit.point);
    const distance = towardLight.length();
    towardLight.normalize();
    const blocker = hits(
      new Ray(hit.point.clone().addScaledVector(towardLight, epsilon), towardLight)
    ).find(other => other.object !== hit.object && other.distance < distance - epsilon);
    const cosine = Math.max(0, hit.normal.dot(towardLight));
    return { blocker, cosine, brightness: blocker ? 0 : cosine };
  }
  return { hits, shade, light, floorIndex };
}

function sampleImage(spec: RaySpec, scene: ReturnType<typeof rayScene>) {
  const { grid, rows = grid } = spec;
  const span = spec.rows === undefined ? legacySpan : imageSpan;
  const centerY = spec.rows === undefined ? camera.y : camera.y - imageSpan / 8;
  return Array.from({ length: grid * rows }, (_, index) => {
    const col = index % grid,
      row = Math.floor(index / grid);
    const pixel = new Vector3(
      spec.rows === undefined ? legacyImageX : imageX,
      centerY + ((span * rows) / grid) * (0.5 - (row + 0.5) / rows),
      camera.z + span * (0.5 - (col + 0.5) / grid)
    );
    const direction = pixel.clone().sub(camera).normalize();
    const [hit, behind] = scene.hits(new Ray(camera, direction));
    const end = hit?.point ?? camera.clone().addScaledVector(direction, cameraDistance);
    const illumination = hit ? scene.shade(hit) : { blocker: undefined, cosine: 0, brightness: 0 };
    return { pixel, end, hit, behind, ...illumination };
  });
}

type Project = (point: Vector3) => [number, number];

function rayInk(layer: VectorNode, color: string, paper: string) {
  const group = svg(layer, 'g', {});
  const halo = svg(group, 'line', { stroke: paper, 'stroke-width': 7, 'stroke-linecap': 'round' });
  const line = svg(group, 'line', {
    stroke: color,
    'stroke-width': 3.3,
    'stroke-linecap': 'round',
  });
  const head = svg(group, 'path', {
    fill: color,
    stroke: paper,
    'stroke-width': 1.4,
    'stroke-linejoin': 'round',
  });
  const dot = svg(group, 'circle', { r: 5.2, fill: color, stroke: paper, 'stroke-width': 1.8 });
  const label = textAt(group, 0, 0, '', 'middle', 'axis-label');
  const draw = (project: Project, start: Vector3, end: Vector3, text: string, dotted = false) => {
    const [x, y] = project(start),
      [u, v] = project(end);
    const length = Math.hypot(u - x, v - y);
    group.setAttribute('visibility', length > 2 ? 'inherit' : 'hidden');
    const ux = (u - x) / Math.max(length, 1),
      uy = (v - y) / Math.max(length, 1);
    for (const shaft of [halo, line]) {
      for (const [key, value] of Object.entries({ x1: x, y1: y, x2: u, y2: v }))
        shaft.setAttribute(key, String(value));
      shaft.setAttribute('opacity', dotted ? '0.42' : '1');
      shaft.setAttribute('stroke-dasharray', dotted ? '6 7' : 'none');
    }
    head.setAttribute(
      'd',
      `M${u} ${v}L${u - 13 * ux - 6 * uy} ${v - 13 * uy + 6 * ux}L${u - 13 * ux + 6 * uy} ${v - 13 * uy - 6 * ux}Z`
    );
    head.setAttribute('opacity', dotted ? '0.48' : '1');
    moveOverlay(dot, [x, y]);
    dot.setAttribute('visibility', dotted ? 'hidden' : 'inherit');
    const side = ux < 0 ? -1 : 1;
    label.textContent = text;
    // Offset the full horizontal label from the dashed shaft, including on steep rays.
    const clearance =
      dotted && text ? Math.max(20, 19 + (Math.abs(uy) * label.glyphs().advance) / 2) : 20;
    label.setAttribute('x', String((x + u) / 2 + clearance * uy * side));
    label.setAttribute('y', String((y + v) / 2 - clearance * ux * side + 4));
    label.setAttribute('opacity', dotted ? '0.65' : '1');
  };
  return Object.assign(draw, { label });
}

const shadowTravel = 0.68;
const phases = ['primary', 'hit', 'shadow', 'shade', 'scan'] as const;

export function castingLesson(
  parent: Group,
  spec: RaySpec,
  colors: Palette,
  overlay: VectorNode,
  beats: Beat[]
) {
  const scene = rayScene(spec);
  const image = sampleImage(spec, scene);
  const { grid, rows = grid } = spec;
  const { light } = scene;
  const objectColors = [colors.accent, colors.far, colors.near, colors.empty];
  const floorColor = colors.ink.clone().lerp(colors.surface, 0.62);
  const baseColor = (object: number) =>
    object === scene.floorIndex ? floorColor : objectColors[object];
  const primaryColor = colors.ink;
  const secondaryColor = colors.near;
  const anchorColor = colors.accent;
  const ink = colors.ink.getStyle(),
    surface = colors.surface.getStyle(),
    accent = anchorColor.getStyle();
  const panelX = 32,
    panelY = 98;
  const panelLink = svg(overlay, 'path', {
    fill: 'none',
    stroke: ink,
    'stroke-width': 1,
    'stroke-opacity': 0.36,
    'data-clearance-ignore': '',
  });
  const output = svg(overlay, 'g', {});
  moveOverlay(output, [panelX, panelY]);
  const outputWidth = Math.min(240, (220 * grid) / rows);
  const tile = outputWidth / grid;
  const outputHeight = rows * tile;
  textAt(output, 0, -16, copy.cameraImage, 'start', 'axis-label');
  svg(output, 'rect', {
    width: outputWidth,
    height: outputHeight,
    fill: surface,
    stroke: ink,
    'stroke-opacity': 0.4,
  });
  const rgb = image.map(ray =>
    ray.hit ? baseColor(ray.hit.object).clone().multiplyScalar(ray.brightness).getStyle() : surface
  );
  const raster = svg(output, 'g', { 'shape-rendering': 'crispEdges', 'data-clearance-ignore': '' });
  const pixels = image.map((_, index) =>
    svg(raster, 'rect', {
      x: (index % grid) * tile,
      y: Math.floor(index / grid) * tile,
      width: tile,
      height: tile,
      fill: rgb[index],
      visibility: 'hidden',
    })
  );
  const gridPath = svg(output, 'path', {
    'data-clearance-ignore': '',
    d: [
      ...Array.from({ length: grid - 1 }, (_, i) => `M${(i + 1) * tile} 0V${outputHeight}`),
      ...Array.from({ length: rows - 1 }, (_, i) => `M0 ${(i + 1) * tile}H${outputWidth}`),
    ].join(''),
    fill: 'none',
    stroke: ink,
    'stroke-opacity': 0.16,
    'stroke-width': 0.7,
  });
  const selectedOutline = svg(output, 'rect', {
    width: tile,
    height: tile,
    fill: 'none',
    stroke: accent,
    'stroke-width': 2.6,
    'data-crop-highlight': '',
  });
  const swatchGroup = svg(output, 'g', {});
  swatchGroup.y = outputHeight + 21;
  const swatch = svg(swatchGroup, 'rect', {
    x: 0,
    y: 3,
    width: 21,
    height: 21,
    stroke: ink,
    'stroke-opacity': 0.6,
  });
  const cosineText = textAt(swatchGroup, 32, 19, '', 'start', 'axis-label');
  const meter = svg(swatchGroup, 'rect', {
    x: 0,
    y: 36,
    width: outputWidth,
    height: 6,
    fill: ink,
    'fill-opacity': 0.13,
  });
  const level = svg(swatchGroup, 'rect', { x: 0, y: 36, height: 6, fill: accent });

  const meshes = spec.objects.map((object, index) => {
    const geometry =
      object.kind === 'sphere'
        ? new SphereGeometry(object.radius, 40, 24)
        : new BoxGeometry(object.size, object.size, object.size);
    const mesh = new Mesh(geometry, lit(baseColor(index)));
    mesh.position.set(...object.at);
    parent.add(mesh);
    return mesh;
  });
  let floor: Mesh | undefined;
  if (spec.ground !== undefined) {
    const resolution = 144;
    const texels = new Uint8Array(resolution ** 2 * 4);
    for (let i = 0; i < resolution ** 2; i++) {
      const x = groundX + floorSize * (((i % resolution) + 0.5) / resolution - 0.5);
      const z = floorSize * (0.5 - (Math.floor(i / resolution) + 0.5) / resolution);
      const hit = {
        object: scene.floorIndex,
        point: new Vector3(x, spec.ground, z),
        normal: new Vector3(0, 1, 0),
        distance: 0,
      };
      const { brightness } = scene.shade(hit);
      const color = floorColor.clone().multiplyScalar(brightness);
      texels.set([color.r * 255, color.g * 255, color.b * 255, 255], i * 4);
    }
    const texture = new DataTexture(texels, resolution, resolution);
    texture.needsUpdate = true;
    const ground = new Mesh(
      new PlaneGeometry(floorSize, floorSize),
      new MeshBasicMaterial({ map: texture, side: DoubleSide, transparent: true, opacity: 0.62 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(groundX, spec.ground, 0);
    parent.add(ground);
    floor = ground;
  }

  const pixelWidth = (spec.rows === undefined ? legacySpan : imageSpan) / grid;
  const framePoint = (row: number, col: number) =>
    image[0].pixel.clone().add(new Vector3(0, (0.5 - row) * pixelWidth, (0.5 - col) * pixelWidth));
  const imagePlane = lines(
    parent,
    [
      ...Array.from({ length: rows + 1 }, (_, i) => [framePoint(i, 0), framePoint(i, grid)]).flat(),
      ...Array.from({ length: grid + 1 }, (_, i) => [framePoint(0, i), framePoint(rows, i)]).flat(),
    ],
    colors.ink,
    0.39
  );
  const frustum = lines(
    parent,
    [0, rows].flatMap(y => [0, grid].flatMap(x => [camera, framePoint(y, x)])),
    colors.ink,
    0.25
  );
  const pixelMesh = new Mesh(
    new PlaneGeometry(pixelWidth, pixelWidth),
    new MeshBasicMaterial({
      color: anchorColor,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    })
  );
  pixelMesh.rotation.y = Math.PI / 2;
  pixelMesh.renderOrder = 8;
  parent.add(pixelMesh);

  const dot = (point: Vector3, size: number, color: Palette['ink']) => {
    const mesh = new Mesh(
      new SphereGeometry(size, 16, 12),
      new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true })
    );
    mesh.position.copy(point);
    mesh.renderOrder = 9;
    parent.add(mesh);
    return mesh;
  };
  const eyeDot = dot(camera, 0.034, primaryColor);
  const lightDot = dot(light, 0.045, secondaryColor);
  const impact = dot(new Vector3(), 0.025, anchorColor);
  const blockerDot = dot(new Vector3(), 0.025, secondaryColor);
  const path = (color: Palette['ink']) => {
    const mesh = new Mesh(
      new BoxGeometry(1, 0.008, 0.008),
      new MeshBasicMaterial({ color, transparent: true, depthWrite: false, depthTest: false })
    );
    mesh.renderOrder = 7;
    parent.add(mesh);
    return mesh;
  };
  const beam = path(primaryColor),
    shadow = path(secondaryColor),
    normal = path(anchorColor);
  shadow.scale.y = shadow.scale.z = 1.5;
  const directionAxis = new Vector3(1, 0, 0);
  function segment(mesh: typeof beam, start: Vector3, end: Vector3) {
    const direction = end.clone().sub(start);
    mesh.position.copy(start).lerp(end, 0.5);
    mesh.scale.x = Math.max(epsilon, direction.length());
    mesh.quaternion.setFromUnitVectors(directionAxis, direction.normalize());
  }
  const dashed = new LineDashedMaterial({
    color: colors.ink,
    dashSize: 0.042,
    gapSize: 0.025,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    depthTest: false,
  });
  const ghostLine = new Line(
    new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]),
    dashed
  );
  ghostLine.frustumCulled = false;
  ghostLine.renderOrder = 6;
  parent.add(ghostLine);
  const occludedPath = new Line(ghostLine.geometry.clone(), dashed.clone());
  occludedPath.material.color.copy(secondaryColor);
  occludedPath.material.opacity = 0.48;
  occludedPath.frustumCulled = false;
  occludedPath.renderOrder = 6;
  parent.add(occludedPath);
  const angleSwatch = new Mesh(
    new PlaneGeometry(0.064, 0.064),
    new MeshBasicMaterial({ depthTest: false, depthWrite: false, side: DoubleSide })
  );
  angleSwatch.renderOrder = 9;
  parent.add(angleSwatch);
  const arcParts = 20;
  const arc = polyline(
    parent,
    Array.from({ length: arcParts + 1 }, () => new Vector3()),
    colors.accent,
    1
  );
  arc.material.depthTest = false;
  arc.frustumCulled = false;
  arc.renderOrder = 8;

  const selectedPixel = (beat: Beat) => {
    const [x, y] = beat.pixel ?? [Math.floor(grid / 2), Math.floor(rows / 2)];
    return y * grid + x;
  };
  const hasScan = beats.some(beat => beat.cast === 'scan');
  const written = new Set<number>();
  const earlier = new Map(
    beats.map(beat => {
      const prior = new Set(written);
      const pixel = selectedPixel(beat);
      if (beat.cast === 'shade' || (beat.cast === 'shadow' && image[pixel].blocker))
        written.add(pixel);
      return [beat, prior];
    })
  );
  const annotations = svg(overlay, 'g', {});
  const angleGuide = svg(annotations, 'polyline', {
    fill: 'none',
    stroke: accent,
    'stroke-width': 2,
  });
  const planeCell = svg(annotations, 'polyline', { fill: accent, 'data-crop-highlight': '' });
  const tangentGuide = svg(annotations, 'polyline', {
    fill: 'none',
    stroke: accent,
    'stroke-width': 2.5,
  });
  const squareGuide = svg(annotations, 'polyline', {
    fill: 'none',
    stroke: accent,
    'stroke-width': 2.5,
    'data-crop-highlight': '',
  });
  const beamLayer = svg(annotations, 'g', {});
  const incoming = rayInk(beamLayer, ink, surface);
  const secondary = rayInk(beamLayer, secondaryColor.getStyle(), surface);
  const continuation = rayInk(beamLayer, secondaryColor.getStyle(), surface);
  const perpendicular = rayInk(beamLayer, accent, surface);
  const bulb = svg(annotations, 'g', {});
  svg(bulb, 'circle', {
    r: 12,
    fill: surface,
    stroke: secondaryColor.getStyle(),
    'stroke-width': 2.6,
  });
  svg(bulb, 'circle', { r: 5, fill: secondaryColor.getStyle() });
  svg(bulb, 'path', {
    d: 'M0 -17V-23M0 17V23M-17 0H-23M17 0H23M-12 -12L-16 -16M12 -12L16 -16M-12 12L-16 16M12 12L16 16',
    fill: 'none',
    stroke: secondaryColor.getStyle(),
    'stroke-width': 1.8,
    'stroke-linecap': 'round',
  });
  const bulbText = textAt(bulb, 0, -29, copy.light, 'middle', 'axis-label');
  const blocked = svg(annotations, 'g', {});
  svg(blocked, 'circle', {
    r: 9,
    fill: surface,
    stroke: secondaryColor.getStyle(),
    'stroke-width': 2.8,
  });
  svg(blocked, 'path', {
    d: 'M-4 -4L4 4M-4 4L4 -4',
    fill: 'none',
    stroke: secondaryColor.getStyle(),
    'stroke-width': 2.7,
    'stroke-linecap': 'round',
  });
  const blockedText = textAt(blocked, 18, -25, copy.blocked, 'start', 'axis-label');
  svg(blocked, 'path', {
    d: 'M7 -7L15 -18',
    fill: 'none',
    stroke: secondaryColor.getStyle(),
    'stroke-width': 1.5,
  });
  const originPin = textAt(annotations, 0, 0, copy.camera, 'middle', 'axis-label');
  const pixelGuide = rayInk(annotations, accent, surface);

  const blockedBeat = beats.find(
    beat => beat.cast === 'shadow' && image[selectedPixel(beat)].blocker
  );
  const blockedSample = blockedBeat && image[selectedPixel(blockedBeat)];
  const shadowCenter = blockedSample?.hit?.point.clone().lerp(light, 0.5);

  let recent = '';
  function frameAt(after: Beat, opacity: number, cue: number) {
    const mode = after.cast ?? 'primary';
    const stage = phases.indexOf(mode);
    const scanning = mode === 'scan';
    const scanCount = scanning ? Math.floor(cue * image.length) : 0;
    const selected = scanning ? Math.min(scanCount, image.length - 1) : selectedPixel(after);
    const sample = image[selected];
    const hit = sample.hit?.point;
    const arrival = spec.explain ? Math.min(1, Math.max(0, (cue - 0.18) / 0.58)) : cue;
    const primaryProgress = mode === 'primary' ? arrival : 1;
    const afterImpact =
      spec.explain && mode === 'shade' ? Math.min(1, Math.max(0, (cue - 0.28) / 0.58)) : 1;
    const shadowProgress = mode === 'shadow' ? Math.min(1, cue / shadowTravel) : afterImpact;
    const shadowLanded = shadowProgress >= 1;
    const finished = scanning && scanCount === image.length;
    const currentWritten =
      shadowLanded &&
      (mode === 'shade' || (mode === 'shadow' && (!!sample.blocker || spec.explain)));
    const retained =
      spec.explain && (mode === 'shade' || scanning) ? new Set<number>() : earlier.get(after)!;
    const legacyReveal = !hasScan && mode === 'shade' ? Math.floor(cue * image.length) : 0;

    return {
      mode,
      stage,
      scanning,
      scanCount,
      selected,
      sample,
      hit,
      primaryProgress,
      shadowProgress,
      shadowLanded,
      finished,
      currentWritten,
      retained,
      legacyReveal,
      opacity,
      cue,
    };
  }
  type RayFrame = ReturnType<typeof frameAt>;

  function paintPixels(state: RayFrame) {
    const {
      opacity,
      scanCount,
      selected,
      currentWritten,
      retained,
      legacyReveal,
      scanning,
      finished,
    } = state;
    output.setAttribute('opacity', String(opacity));
    const paintKey = `${scanCount}/${selected}/${currentWritten}/${[...retained].join(',')}/${legacyReveal}/${scanning}`;
    if (paintKey !== recent) {
      recent = paintKey;
      pixels.forEach((pixel, i) => {
        pixel.setAttribute(
          'visibility',
          i < Math.max(scanCount, legacyReveal) ||
            (currentWritten && i === selected) ||
            retained.has(i)
            ? 'visible'
            : 'hidden'
        );
      });
      selectedOutline.setAttribute('x', String((selected % grid) * tile));
      selectedOutline.setAttribute('y', String(Math.floor(selected / grid) * tile));
      selectedOutline.setAttribute('visibility', finished ? 'hidden' : 'visible');
      gridPath.setAttribute('stroke-opacity', finished ? '0' : '0.16');
    }
  }

  function paintRays(state: RayFrame, t: number) {
    const {
      mode,
      sample,
      finished,
      scanning,
      stage,
      opacity,
      hit,
      primaryProgress,
      shadowProgress,
      shadowLanded,
      cue,
    } = state;
    selectedOutline.setAttribute('fill', spec.explain && mode === 'primary' ? accent : 'none');
    pixelMesh.position.copy(sample.pixel);
    pixelMesh.visible = !finished;
    beam.visible = !finished;
    beam.material.opacity = (scanning ? 0.53 : 1) * opacity;
    segment(beam, camera, camera.clone().lerp(sample.end, primaryProgress));
    impact.visible = !!hit && stage > 0 && !finished;
    if (hit) impact.position.copy(hit);
    ghostLine.visible = mode === 'hit' && !!sample.behind && !!hit;
    if (ghostLine.visible) {
      const rear = sample.behind!.point;
      const past = rear.clone().addScaledVector(rear.clone().sub(hit!).normalize(), 0.33);
      moveVertices(ghostLine, [hit!, hit!.clone().lerp(past, t)]);
      ghostLine.computeLineDistances();
    }
    shadow.visible = !!hit && (mode === 'shadow' || mode === 'shade');
    blockerDot.visible = shadow.visible && !!sample.blocker && shadowLanded;
    occludedPath.visible = blockerDot.visible;
    if (hit && shadow.visible) {
      const end = sample.blocker?.point ?? light;
      segment(shadow, hit, hit.clone().lerp(end, shadowProgress));
      blockerDot.position.copy(end);
      if (occludedPath.visible) {
        moveVertices(occludedPath, [end, light]);
        occludedPath.computeLineDistances();
      }
    }
    const blockedObject = blockerDot.visible ? sample.blocker?.object : undefined;
    meshes.forEach((mesh, index) => {
      const focus =
        stage === 0 || scanning || index === sample.hit?.object || index === blockedObject;
      mesh.material.opacity = (focus ? 1 : DIM) * opacity;
      mesh.material.depthWrite = mesh.material.opacity > 0.99;
      mesh.material.emissive
        .copy(secondaryColor)
        .multiplyScalar(index === blockedObject ? (0.75 * (1 - cue)) / (1 - shadowTravel) : 0);
    });
  }

  function paintShading(state: RayFrame) {
    const { mode, hit, sample, selected, shadowLanded } = state;
    const shading = mode === 'shade' && !!hit && !sample.blocker;
    normal.visible = arc.visible = angleSwatch.visible = shading;
    swatchGroup.setAttribute('visibility', shading && shadowLanded ? 'visible' : 'hidden');
    meter.setAttribute('visibility', shading ? 'visible' : 'hidden');
    const labels: { text: string; point: Vector3 }[] = [
      { text: copy.camera, point: camera.clone().add(new Vector3(0, -0.11, 0)) },
      { text: copy.light, point: light.clone().add(new Vector3(0, 0.075, 0)) },
    ];
    let anglePoints: Vector3[] = [];
    let tangentPoints: Vector3[] = [];
    let squarePoints: Vector3[] = [];
    if (shading && hit && sample.hit) {
      const n = sample.hit.normal,
        l = light.clone().sub(hit).normalize();
      const theta = n.angleTo(l);
      const radius = 0.205;
      segment(normal, hit, hit.clone().addScaledVector(n, 0.4));
      const tangent = l.clone().addScaledVector(n, -Math.cos(theta)).normalize();
      const onArc = (angle: number, length: number) =>
        hit
          .clone()
          .addScaledVector(n, Math.cos(angle) * length)
          .addScaledVector(tangent, Math.sin(angle) * length);
      anglePoints = Array.from({ length: arcParts + 1 }, (_, i) =>
        onArc((theta * i) / arcParts, radius)
      );
      moveVertices(arc, anglePoints);
      // The cross-product gives a surface tangent in the normal-light plane's perpendicular direction.
      const surfaceTangent = tangent.clone().cross(n).normalize();
      const side = 0.09;
      const foot = hit.clone().addScaledVector(surfaceTangent, side);
      tangentPoints = [
        hit.clone().addScaledVector(surfaceTangent, -side * 1.6),
        hit.clone().addScaledVector(surfaceTangent, side * 1.6),
      ];
      squarePoints = [
        foot,
        foot.clone().addScaledVector(n, side),
        hit.clone().addScaledVector(n, side),
      ];
      labels.push({ text: copy.theta, point: onArc(theta / 2, radius + 0.082) });
      labels.push({ text: rayNormal, point: hit.clone().addScaledVector(n, 0.46) });
      angleSwatch.position.copy(onArc(theta / 2, radius + 0.082)).add(new Vector3(0, 0.1, 0));
      angleSwatch.material.color.set(rgb[selected]);
      swatch.setAttribute('fill', rgb[selected]);
      cosineText.textContent = cosine(Math.round(100 * Math.cos(theta)));
      level.setAttribute('width', String(outputWidth * Math.max(0, Math.cos(theta))));
    }
    return { shading, labels, anglePoints, tangentPoints, squarePoints };
  }

  function paintExplanatoryMeshes(state: RayFrame, shading: boolean) {
    const { mode, opacity, shadowLanded, selected, scanning, sample } = state;
    const sight = mode === 'primary' || mode === 'hit';
    const lighting = mode === 'shadow' || shading;
    annotations.setAttribute('visibility', opacity > 0 ? 'visible' : 'hidden');
    beam.visible =
      shadow.visible =
      normal.visible =
      arc.visible =
      impact.visible =
      blockerDot.visible =
        false;
    ghostLine.visible = occludedPath.visible = eyeDot.visible = lightDot.visible = false;
    imagePlane.visible = sight;
    pixelMesh.visible = false;
    frustum.visible = false;
    angleSwatch.visible = false;
    if (mode === 'shadow') {
      swatchGroup.setAttribute('visibility', shadowLanded ? 'visible' : 'hidden');
      swatch.setAttribute('fill', rgb[selected]);
      cosineText.textContent = sample.blocker ? copy.shadowed : copy.lit;
      level.setAttribute('width', '0');
    }
    output.setAttribute('display', 'inline');
    if (floor) floor.visible = mode === 'shadow' || scanning;
    meshes.forEach((mesh, i) => {
      mesh.visible =
        mode === 'hit' ||
        scanning ||
        (lighting && (i === sample.hit?.object || i === blockedSample?.blocker?.object));
      const surfaceOpacity = mode === 'hit' ? 0.55 : 1;
      mesh.material.opacity =
        mode === 'shadow' && i === blockedSample?.blocker?.object ? 0.3 : surfaceOpacity;
      mesh.material.depthWrite = mesh.material.opacity === 1;
      mesh.material.emissive.setScalar(0);
    });

    return { sight, lighting };
  }

  return (_before: Beat, after: Beat, t: number, opacity: number, cue: number) => {
    const state = frameAt(after, opacity, cue);
    const { mode, sample, hit, selected, shadowLanded, shadowProgress, primaryProgress } = state;
    paintPixels(state);
    paintRays(state, t);
    const { shading, labels, anglePoints, tangentPoints, squarePoints } = paintShading(state);
    const target = mode === 'primary' ? sample.pixel : (sample.blocker?.point ?? sample.end);
    if (!spec.explain) return { rows: [], target, labels };

    const { sight, lighting } = paintExplanatoryMeshes(state, shading);
    const behind = mode === 'hit' ? sample.behind?.point : undefined;
    const end =
      mode === 'primary'
        ? sample.pixel.clone().addScaledVector(sample.pixel.clone().sub(camera).normalize(), 0.13)
        : (behind ?? sample.end);
    let center = new Vector3(0.03, -0.06, 0);
    if (sight) center = camera.clone().lerp(end, 0.49);
    else if (mode === 'shadow') center = shadowCenter ?? target;
    else if (shading && hit) center = hit.clone().lerp(light, 0.45);
    const frame = sight
      ? {
          center,
          yaw: 0.48,
          pitch: 0.27,
          distance: mode === 'primary' ? 2.9 : 4.45,
          shift: mode === 'primary' ? -0.22 : -0.17,
        }
      : { center, yaw: 0.34, pitch: 0.31, distance: lighting ? 4.85 : 5.55, shift: -0.14 };
    const cell = [
      panelX + ((selected % grid) + 0.5) * tile,
      panelY + (Math.floor(selected / grid) + 0.5) * tile,
    ] as const;
    function projectPlane(project: Project) {
      planeCell.setAttribute('visibility', sight ? 'visible' : 'hidden');
      if (sight) {
        const row = Math.floor(selected / grid),
          col = selected % grid;
        const corners = [
          framePoint(row, col),
          framePoint(row, col + 1),
          framePoint(row + 1, col + 1),
          framePoint(row + 1, col),
        ];
        planeCell.setAttribute('points', corners.map(point => project(point).join(',')).join(' '));
      }
    }
    function projectSight(project: Project) {
      if (sight) {
        const tip = camera.clone().lerp(mode === 'hit' ? sample.end : end, primaryProgress);
        incoming(project, camera, tip, primaryProgress >= 1 ? copy.primary : '');
        const [eyeX, eyeY] = project(camera);
        moveOverlay(originPin, [eyeX, eyeY + 22]);
        if (mode === 'hit' && sample.behind && hit) {
          continuation(project, hit, sample.behind.point, copy.behind, true);
        }
      }
    }
    function projectLighting(project: Project) {
      if (lighting && hit) {
        moveOverlay(bulb, project(light));
        const stop = sample.blocker?.point ?? light;
        secondary(
          project,
          hit,
          hit.clone().lerp(stop, shadowProgress),
          sample.blocker ? '' : copy.lightRay
        );
        if (sample.blocker && shadowLanded) {
          continuation(project, stop, light, '', true);
          blocked.setAttribute('visibility', 'inherit');
          moveOverlay(blocked, project(stop));
        }
        if (shading) {
          const tip = hit.clone().addScaledVector(sample.hit!.normal, 0.4);
          perpendicular(project, hit, tip, copy.normal);
          const [x, y] = project(tip);
          perpendicular.label.setAttribute(
            'x',
            String(x - perpendicular.label.glyphs().advance / 2 - 12)
          );
          perpendicular.label.setAttribute('y', String(y + 18));
        }
      }
    }
    return {
      rows: [],
      target,
      frame,
      pins: [
        originPin,
        incoming.label,
        secondary.label,
        continuation.label,
        perpendicular.label,
        pixelGuide.label,
        bulbText,
        blockedText,
      ],
      project(project: Project) {
        projectPlane(project);
        for (const [guide, points] of [
          [angleGuide, shadowLanded ? anglePoints : []],
          [tangentGuide, tangentPoints],
          [squareGuide, squarePoints],
        ] as const) {
          guide.setAttribute('points', points.map(point => project(point).join(',')).join(' '));
        }
        const [cameraX, cameraY] = project(camera);
        const panelRight = panelX + outputWidth;
        panelLink.setAttribute(
          'd',
          'M' +
            panelRight +
            ' ' +
            panelY +
            'L' +
            cameraX +
            ' ' +
            cameraY +
            'L' +
            panelRight +
            ' ' +
            (panelY + outputHeight)
        );
        panelLink.setAttribute('visibility', sight ? 'visible' : 'hidden');
        for (const label of [
          incoming.label,
          secondary.label,
          continuation.label,
          perpendicular.label,
          pixelGuide.label,
          bulbText,
          blockedText,
        ])
          moveOverlay(label, [0, 0]);
        const hide = (draw: ReturnType<typeof rayInk>) => draw(project, center, center, '');
        for (const draw of [incoming, secondary, continuation, perpendicular, pixelGuide])
          hide(draw);
        const lightFocus = mode === 'shadow' && shadowLanded ? hit : undefined;
        const linked = mode === 'primary' ? sample.pixel : lightFocus;
        if (linked) {
          const [x, y] = project(linked);
          const edge: [number, number] = [cell[0] + tile / 2, cell[1]];
          const guideProject: Project = point => (point === linked ? [x, y] : edge);
          if (mode === 'primary') pixelGuide(guideProject, center, linked, copy.samePixel);
          else pixelGuide(guideProject, linked, center, copy.samePixel, true);
        }
        bulbText.setAttribute('x', '0');
        bulbText.setAttribute('y', '-36');
        blockedText.setAttribute('x', '18');
        blockedText.setAttribute('y', '-29');
        bulb.setAttribute('visibility', lighting ? 'inherit' : 'hidden');
        originPin.setAttribute('visibility', sight ? 'inherit' : 'hidden');
        blocked.setAttribute('visibility', 'hidden');
        projectSight(project);
        projectLighting(project);
      },
    };
  };
}
