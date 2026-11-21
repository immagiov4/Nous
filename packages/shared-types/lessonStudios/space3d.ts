import { DirectionalLight, Group, HemisphereLight, PerspectiveCamera, Scene, Vector3 } from 'three';
import { pill, textAt } from './chart';
import { chartViewport, HEIGHT, WIDTH } from './chartDimensions';
import { appear, DIM, EXIT, FOCUS, MOVE, timeline } from './motion';
import {
  axis as axisName,
  axisNames,
  coordinateSeparator,
  copy,
  emptyDepth,
  layerNames,
  polygonNames,
  resolution,
  sectionLabels,
  shapeNames,
} from './space3dCopy.it';
import { dissectionLesson } from './space3dDissection';
import {
  disposeSpace3dMeshes,
  placeOpacity,
  type Space3dColors,
  space3dPalette,
} from './space3dDraw';
import { origin } from './space3dMath';
import { buildSpace3dOverlay } from './space3dOverlay';
import { pipelineLayer } from './space3dPipeline';
import { proceduralBeats } from './space3dProcedures';
import { space3dProjection } from './space3dProjection';
import { castingLesson } from './space3dRaycast';
import { rotationLesson } from './space3dRotations';
import { sliceLesson } from './space3dSlices';
import { cubeSection, sectionLesson, sectionPlane, solidLesson } from './space3dSolids';
import {
  type Beat,
  type LayerName,
  phases,
  resolveSpace3dSpec,
  type Space3dSpec,
} from './space3dSpec';
import { denseLayer, rayLayer, shapeLayer, treeLayer } from './space3dVolume';
import { surfaceLayer } from './space3dVoxelSurface';
import { motionEase } from './timeline';
import { openingCueDelay } from './traceTiming';
import { svg, type VectorNode } from './vectorScene';

const orientations = {
  front: { yaw: 0, pitch: 0 },
  iso: { yaw: 0.56, pitch: 0.37 },
  top: { yaw: 0, pitch: 1.5 },
};
const rayStatus = { skip: copy.skip, descend: copy.descend, hit: copy.hit } as const;
const int = new Intl.NumberFormat('it-IT');
const decimal = new Intl.NumberFormat('it-IT', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const position = (values: number[]) =>
  values
    .map(value => decimal.format(Math.abs(value) < 0.005 ? 0 : value))
    .join(coordinateSeparator);
const depthText = (depth: number | null) => (depth === null ? emptyDepth : decimal.format(depth));
const short = (time: number, next: number, duration: number) => Math.min(duration, next - time);

function makeHud(overlay: VectorNode) {
  const card = svg(overlay, 'g', {});
  card.x = 735;
  card.y = 123;
  svg(card, 'line', { class: 'hud-rule', x1: -16, x2: -16, y1: 0, y2: 215 });
  const title = textAt(card, 0, 15, '', 'start', 'axis-label');
  const rows = Array.from({ length: 3 }, (_, i) => {
    const row = svg(card, 'g', {});
    row.y = 39 + 59 * i;
    const value = textAt(row, 0, 15, '', 'start', 'parameter');
    const label = textAt(row, 0, 36, '', 'start', 'axis-label');
    return { value, label };
  });
  return (heading: string, values: [string, string][], visible: boolean) => {
    card.setAttribute('visibility', visible ? 'visible' : 'hidden');
    title.textContent = heading.toLocaleUpperCase('it-IT');
    rows.forEach(({ value, label }, i) => {
      const [valueText, labelText] = values[i] ?? ['', ''];
      if (value.textContent !== valueText) value.textContent = valueText;
      if (label.textContent !== labelText) label.textContent = labelText;
    });
  };
}

function focusedLayer(beat: Beat, show: LayerName[], prior: LayerName) {
  if (beat.focus) return beat.focus;
  if (beat.depth !== undefined && show.includes('octree') && !show.includes('ray')) return 'octree';
  return show.includes(prior) ? prior : show[0];
}

function cameraOrientation(camera: NonNullable<Beat['camera']>, focus: LayerName) {
  if (camera === 'front' || camera === 'top') return orientations[camera];
  if (focus === 'slice-stack') return { yaw: 0.11, pitch: 0.22 };
  if (focus === 'raycast') return { yaw: 0.35, pitch: 0.39 };
  return orientations.iso;
}

function cameraDistance(focus: LayerName, phase: number, project: boolean) {
  switch (focus) {
    case 'pipeline':
      return phase >= 2 ? 4.7 : 3.55;
    case 'triangle-voxelize':
      return project ? 4.45 : 3.95;
    case 'octree':
      return 3.65;
    case 'raycast':
      return 6.15;
    case 'plane-section':
      return 5.2;
    default:
      return 4.55;
  }
}

function generatedCallout(focus: LayerName, { section, cast }: Beat) {
  if (focus === 'plane-section') {
    if (typeof section === 'string') return sectionLabels[section];
    const { normal, offset } = sectionPlane(section);
    return polygonNames[cubeSection(normal, offset).length] ?? copy.degenerated;
  }
  if (focus === 'raycast') {
    if (cast === 'shadow' || cast === 'shade') return copy.lightRay;
    return cast === 'scan' ? copy.cameraImage : copy.primary;
  }
  return layerNames[focus];
}

function beatTargets(spec: Space3dSpec) {
  let show = spec.layers;
  let focus = show[0];
  let camera: NonNullable<Beat['camera']> = 'iso';
  let depth = 0,
    progress = 0,
    project = false,
    phase = 0,
    treeInspection = 0;
  return spec.beats.map(beat => {
    show = beat.show ?? show;
    focus = focusedLayer(beat, show, focus);
    camera = beat.camera ?? camera;
    const priorDepth = depth;
    depth = beat.depth ?? depth;
    treeInspection =
      focus === 'octree' && depth > 0 && priorDepth === depth ? treeInspection + 1 : 0;
    progress = beat.progress ?? progress;
    project = beat.project ?? project;
    phase = beat.phase ? phases.indexOf(beat.phase) : phase;

    const close = camera.startsWith('close-on:');
    const { yaw, pitch } = cameraOrientation(camera, focus);
    const distance = cameraDistance(focus, phase, project);
    return {
      show,
      focus,
      yaw,
      pitch,
      distance: close ? distance * 0.84 : distance,
      depth,
      progress,
      project: +project,
      phase,
      closeLayer: show.find(name => camera === 'close-on:' + name),
      treeInspection,
    };
  });
}

function procedureTimes(count: number, pins: { index: number; time: number }[], end: number) {
  const first = pins[0];
  const anchors = [...pins, { index: count, time: end }];
  if (first.index > 0) {
    const next = anchors[1].time;
    const time = first.time || openingCueDelay(next * 1000) / 1000;
    anchors[0] = { index: first.index, time };
    anchors.unshift({ index: 0, time: 0 });
  }
  return anchors.slice(0, -1).flatMap((from, index) => {
    const to = anchors[index + 1];
    const steps = to.index - from.index;
    return Array.from(
      { length: steps },
      (_, offset) => from.time + ((to.time - from.time) * offset) / steps
    );
  });
}

export function buildSpace3d(
  authored: Parameters<typeof resolveSpace3dSpec>[0],
  root: VectorNode,
  beatTimesMs: number[],
  paintColors?: Space3dColors
) {
  let spec = resolveSpace3dSpec(authored);
  const timelineLength = Number(root.data.durationMs) / 1000;
  const procedure = proceduralBeats(spec, beatTimesMs);
  const times = procedureTimes(procedure.beats.length, procedure.pins, timelineLength);
  spec = { ...spec, beats: procedure.beats };
  const colors = space3dPalette(paintColors);
  const scene = new Scene();
  const {
    surface: overlay,
    width,
    height,
    inspect,
    placeCallout,
    placePin,
  } = buildSpace3dOverlay(root, spec.title);
  const camera = new PerspectiveCamera(19, width / height, 0.05, 15);
  const projection = space3dProjection(scene, camera);

  const sky = new HemisphereLight(0xffffff, 0xe8d8ca, 1.86);
  const lamp = new DirectionalLight(0xffffff, 1.62);
  lamp.position.set(-2, 3, 4);
  scene.add(sky, lamp);
  const groups = new Map(
    spec.layers.map(name => {
      const group = new Group();
      scene.add(group);
      return [name, group] as const;
    })
  );
  const shape = groups.get('shape');
  if (shape) shapeLayer(shape, spec.shape!, colors);
  const dense = groups.has('voxel-grid')
    ? denseLayer(groups.get('voxel-grid')!, spec, colors)
    : undefined;
  const tree = groups.has('octree') ? treeLayer(groups.get('octree')!, spec, colors) : undefined;
  const ray = groups.has('ray')
    ? rayLayer(groups.get('ray')!, spec, colors, tree!.root)
    : undefined;
  const triangle = groups.has('triangle-voxelize')
    ? surfaceLayer(groups.get('triangle-voxelize')!, spec, colors)
    : undefined;
  const pipeline = groups.has('pipeline')
    ? pipelineLayer(groups.get('pipeline')!, spec, colors)
    : undefined;

  type LessonView = {
    rows: string[][];
    target: Vector3;
    labels?: { text: string; point: Vector3 }[];
    pins?: VectorNode[];
    frame?: { center: Vector3; yaw: number; pitch: number; distance: number; shift: number };
    project?: (project: (point: Vector3) => [number, number]) => void;
  };
  type Lesson = (before: Beat, after: Beat, t: number, strength: number, cue: number) => LessonView;
  const lessons = new Map<LayerName, Lesson>();
  const solid = groups.get('solid'),
    slices = groups.get('slice-stack'),
    section = groups.get('plane-section');
  const rotation = groups.get('rotation'),
    raycast = groups.get('raycast');
  if (solid) lessons.set('solid', solidLesson(solid, spec.solid!, colors));
  if (rotation) lessons.set('rotation', rotationLesson(rotation, spec.turns!, colors));
  let previousBeat: Beat = {};
  const geometryBeats = spec.beats.map(beat => (previousBeat = { ...previousBeat, ...beat }));

  const hud = makeHud(overlay);
  if (section) lessons.set('plane-section', sectionLesson(section, colors, overlay));
  if (slices) {
    const proof = ['dissect', 'superpose', 'reassemble', 'cavalieri', 'conclusion'];
    const classic = new Group(),
      dissection = new Group();
    slices.add(classic, dissection);
    const use = geometryBeats.map(beat => proof.includes(beat.sliceView ?? ''));
    const drawClassic = use.includes(false)
      ? sliceLesson(classic, spec.slices!, colors, overlay)
      : undefined;
    const drawProof = use.includes(true)
      ? dissectionLesson(dissection, spec.slices!, colors, overlay)
      : undefined;
    lessons.set('slice-stack', (before, after, t, strength, cue) => {
      const showingProof = proof.includes(after.sliceView ?? '');
      classic.visible = !showingProof && strength > 0;
      dissection.visible = showingProof && strength > 0;
      const oldView = drawClassic?.(before, after, t, showingProof ? 0 : strength, cue);
      const newView = drawProof?.(before, after, t, showingProof ? strength : 0, cue);
      return (showingProof ? newView : oldView)!;
    });
  }
  if (raycast)
    lessons.set('raycast', castingLesson(raycast, spec.raycast!, colors, overlay, geometryBeats));
  const labels = Array.from({ length: 6 }, () => textAt(overlay, 0, 0, '', 'middle', 'axis-label'));
  const targets = beatTargets(spec);
  const init = targets[0];
  const { yaw, pitch, distance, depth, progress, project, phase } = init;
  const pose = { yaw, pitch, distance, depth, progress, project, phase, lesson: 0 };
  const layerStrength = (target: typeof init, name: LayerName) => {
    if (!target.show.includes(name)) return 0;
    return target.focus === name ? 1 : DIM;
  };
  const strengths = new Map(spec.layers.map(name => [name, { value: layerStrength(init, name) }]));
  const strengthOf = (name: LayerName) => strengths.get(name)?.value ?? 0;
  const play = timeline();
  const poseTracks = {
    yaw: { value: yaw },
    pitch: { value: pitch },
    distance: { value: distance },
    depth: { value: depth },
    progress: { value: progress },
    project: { value: project },
    phase: { value: phase },
    lesson: { value: 0 },
  };
  const sectionLabelTimes = times.map((time, index) =>
    index === 0 ? time : time + short(time, times[index + 1] ?? Infinity, MOVE.duration)
  );
  function planMotion(index: number) {
    const next = times[index + 1] ?? Infinity;
    const target = targets[index];
    const { focus } = target;
    const duration = short(times[index], next, MOVE.duration);
    const sweep =
      (focus === 'ray' || focus === 'triangle-voxelize') &&
      target.progress > targets[index - 1].progress;
    for (const field of Object.keys(poseTracks) as (keyof typeof poseTracks)[]) {
      const value = field === 'lesson' ? index : target[field];
      const timing =
        field === 'progress' && sweep
          ? {
              duration: (times[index + 1] ?? timelineLength) - times[index],
              ease: 'none' as const,
            }
          : { ...MOVE, duration };
      play.to(poseTracks[field], { ...timing, value }, times[index]);
    }
    for (const [name, strength] of strengths) {
      play.to(
        strength,
        {
          ...FOCUS,
          duration: short(times[index], next, FOCUS.duration),
          value: layerStrength(target, name),
        },
        times[index]
      );
    }
  }
  const aims = spec.beats.map((beat, index) => {
    if (index > 0) planMotion(index);
    const { focus } = targets[index];
    const next = times[index + 1] ?? Infinity;
    const label =
      beat.label ?? (beat.callout ? generatedCallout(focus, geometryBeats[index]) : undefined);
    if (!label) return undefined;
    const callout = pill(overlay, label, focus === 'plane-section' ? 'feature-tag' : 'callout');
    if (focus !== 'plane-section') appear(play, callout.group, times[index], next);
    return callout;
  });

  const exitEase = motionEase(EXIT.ease);
  const target = new Vector3();
  const cameraTarget = new Vector3();
  let meshes: ReturnType<typeof projection.fit> = [];
  function closeTransition() {
    const previous = Math.floor(pose.lesson);
    return {
      from: targets[previous].closeLayer,
      to: targets[Math.ceil(pose.lesson)].closeLayer,
      blend: pose.lesson - previous,
    };
  }

  function drawLayerStates(index: number, branchZoom: number) {
    for (const [name, group] of groups)
      placeOpacity(group, strengthOf(name) * (name === 'shape' ? 1 - branchZoom : 1));

    const treeState =
      tree && strengthOf('octree') > 0
        ? tree.draw(pose.depth, targets[index].treeInspection)
        : undefined;
    // The outgoing camera target can still be moving after its layer has faded out.
    const { from, to } = closeTransition();
    const needsLayer = (name: LayerName) => strengthOf(name) > 0 || name === from || name === to;
    const rayState = ray && needsLayer('ray') ? ray.draw(pose.depth, pose.progress) : undefined;
    const voxelState =
      triangle && needsLayer('triangle-voxelize')
        ? triangle.draw(pose.progress, pose.project)
        : undefined;
    const samples = pipeline && needsLayer('pipeline') ? pipeline.draw(pose.phase) : undefined;
    return { treeState, rayState, voxelState, samples };
  }

  function drawViews(index: number, seconds: number, reduced: boolean) {
    const geometryIndex = Math.ceil(pose.lesson);
    const prior = Math.max(0, geometryIndex - 1);
    const cueBeat = geometryBeats[index];
    const span = Math.max(MOVE.duration, (times[index + 1] ?? timelineLength) - times[index]);
    const sustained =
      cueBeat.cast === 'scan' ||
      ['slices', 'dissect', 'superpose', 'reassemble', 'cavalieri'].includes(
        cueBeat.sliceView ?? ''
      );
    const cueDuration = sustained ? span * 0.75 : MOVE.duration;
    const cue = reduced ? 1 : Math.min(1, Math.max(0, (seconds - times[index]) / cueDuration));
    const views = new Map<LayerName, LessonView>();
    for (const [name, draw] of lessons) {
      const active = name === 'raycast' || name === 'slice-stack';
      const current = active ? index : geometryIndex;
      const previous = active ? Math.max(0, index - 1) : prior;
      const blend = active ? Math.max(0, Math.min(1, pose.lesson - previous)) : pose.lesson - prior;
      const transition = current === 0 ? 1 : blend;
      views.set(
        name,
        draw(geometryBeats[previous], geometryBeats[current], transition, strengthOf(name), cue)
      );
    }
    return views;
  }

  function pipelineRows(state: ReturnType<NonNullable<typeof pipeline>['draw']>, stage: number) {
    const rows: [string, string][] = [];
    if (stage === 0) rows.push([position(state.local.toArray()), copy.modelCoords]);
    if (stage === 1) rows.push([position(state.view.toArray()), copy.cameraCoords]);
    if (stage === 2)
      rows.push(
        [position([state.clip.x, state.clip.y]), copy.clipCoords],
        [decimal.format(state.clip.w), copy.cameraDepth]
      );
    if (stage === 3)
      rows.push(
        [position([state.ndc.x, state.ndc.y]), copy.afterDivide],
        [decimal.format(state.clip.w), copy.divisor]
      );
    if (stage === 4) rows.push([`${state.written} / ${state.fragments}`, copy.insideTriangle]);
    if (stage === 5) {
      const read = state.sample;
      const comparison = read?.winner === 1 ? copy.write : copy.discard;
      rows.push(
        [depthText(read?.prior ?? null), copy.knownDepth],
        [depthText(read?.incoming ?? null), copy.incomingDepth],
        [read?.incoming == null ? copy.keep : comparison, copy.testResult]
      );
    }
    return rows;
  }

  function drawHud(
    index: number,
    branchZoom: number,
    states: ReturnType<typeof drawLayerStates>,
    views: Map<LayerName, LessonView>
  ) {
    const { treeState, rayState, voxelState, samples } = states;
    const { focus } = targets[index];
    const rows: [string, string][] = [];
    target.set(0.27, 0.16, 0.16);
    switch (focus) {
      case 'shape':
        rows.push([shapeNames[spec.shape!], copy.surface], ['1 × 1 × 1', copy.unitCube]);
        break;
      case 'voxel-grid':
        rows.push(
          [int.format(spec.n ** 3), copy.gridCells],
          [int.format(dense!), copy.occupied],
          [resolution(spec.n), copy.resolution]
        );
        break;
      case 'octree': {
        const view = treeState ?? tree!.cuts[Math.ceil(pose.depth)];
        rows.push(
          [int.format(view.nodes), copy.treeNodes],
          [int.format(tree!.total), copy.equivalent],
          [String(Math.ceil(pose.depth)), copy.depth]
        );
        target.set(0.46, 0.27, 0.46);
        break;
      }
      case 'ray': {
        const { current, tests, skips, tip } = rayState ?? ray!.draw(pose.depth, pose.progress);
        const status = current ? rayStatus[current.kind] : copy.outside;
        rows.push(
          [status, copy.rayNode],
          [int.format(tests), copy.visited],
          [int.format(skips), copy.skipped]
        );
        target.copy(tip);
        break;
      }
      case 'triangle-voxelize': {
        const {
          tested,
          total,
          hit,
          axis,
          focus: point,
        } = voxelState ?? triangle!.draw(pose.progress, pose.project);
        const coverage: [string, string] = [
          spec.mode === 'centre' ? copy.center : copy.conservative,
          copy.coverage,
        ];
        rows.push(
          [`${int.format(tested)} / ${int.format(total)}`, copy.checked],
          [int.format(hit), copy.occupied],
          pose.project > 0.5 ? [axisName(axisNames[axis]), copy.dominant] : coverage
        );
        target.copy(point);
        break;
      }
      case 'pipeline': {
        const state = samples ?? pipeline!.draw(pose.phase);
        rows.push(...pipelineRows(state, targets[index].phase));
        target.copy(state.focus);
        break;
      }
      default: {
        const view = views.get(focus);
        if (view) {
          for (const [value, label] of view.rows) rows.push([value, label]);
          target.copy(view.target);
        }
        break;
      }
    }
    hud(
      layerNames[focus],
      rows,
      focus !== 'slice-stack' &&
        focus !== 'raycast' &&
        focus !== 'plane-section' &&
        branchZoom === 0
    );
  }

  function placeCamera(
    index: number,
    branchZoom: number,
    states: ReturnType<typeof drawLayerStates>,
    views: Map<LayerName, LessonView>
  ) {
    const { rayState, voxelState, samples } = states;
    const view = views.get(targets[index].focus);
    const sceneTargets = new Map<LayerName | undefined, Vector3 | undefined>([
      ...[...views].map(([name, frameView]) => [name, frameView.target] as const),
      ['ray', rayState?.tip],
      ['triangle-voxelize', voxelState?.focus],
      ['pipeline', samples?.focus],
    ]);
    const radius = Math.cos(pose.pitch) * pose.distance;
    camera.position.set(
      Math.sin(pose.yaw) * radius,
      Math.sin(pose.pitch) * pose.distance,
      Math.cos(pose.yaw) * radius
    );
    const { from, to, blend } = closeTransition();
    cameraTarget.lerpVectors(
      sceneTargets.get(from) ?? origin,
      sceneTargets.get(to) ?? origin,
      blend
    );
    const frame = view?.frame;
    if (frame) {
      const { center, yaw, pitch, distance, shift } = frame;
      const horizontal = Math.cos(pitch) * distance;
      cameraTarget.copy(center);
      camera.position.set(
        Math.sin(yaw) * horizontal,
        Math.sin(pitch) * distance,
        Math.cos(yaw) * horizontal
      );
      camera.setViewOffset(width, height, width * shift, 0, width, height);
    } else camera.setViewOffset(width, height, width * 0.146 * (1 - branchZoom), 0, width, height);
    camera.position.add(cameraTarget);
    camera.lookAt(cameraTarget);
  }

  function paintPins(view: LessonView | undefined) {
    for (const [i, label] of labels.entries()) {
      const pin = view?.labels?.[i];
      label.textContent = pin?.text ?? '';
      label.x = 0;
      label.y = 0;
      if (!pin) continue;
      const [x, y] = projection.project(pin.point);
      const half = label.glyphs().advance / 2 + 12;
      label.setAttribute('x', Math.max(half, Math.min(WIDTH - half, x)));
      label.setAttribute('y', Math.max(20, Math.min(HEIGHT - 12, y)));
    }
    for (const label of [...labels, ...(view?.pins ?? [])]) placePin(label, meshes);
  }

  function paintCallout(index: number, seconds: number, reduced: boolean) {
    const { focus } = targets[index];
    // During the plane's turn neither the outgoing nor the arriving label describes the cut.
    const aimIndex =
      focus === 'plane-section' && !reduced && seconds < sectionLabelTimes[index] ? -1 : index;
    aims.forEach((callout, i) => {
      if (!callout || targets[i].focus !== 'plane-section') return;
      const next = times[i + 1] ?? Infinity;
      const exit = Math.min(EXIT.duration, (next - sectionLabelTimes[i]) / 3);
      const departure = exit > 0 ? exitEase(Math.max(0, (seconds - (next - exit)) / exit)) : 0;
      callout.group.opacity = i === aimIndex ? 1 - departure : 0;
    });
    const aim = aims[aimIndex];
    if (aim && focus === 'plane-section') {
      aim.place([834, 241], [834, 392]);
    } else if (aim) {
      const [u, v] = projection.project(target);
      const x = Math.min(WIDTH * 0.7, Math.max(25, u));
      const y = Math.min(HEIGHT - 24, Math.max(24, v));
      const offset = x > 540 ? -108 : 102;
      placeCallout(aim, [x, y], [x + offset, y > 350 ? y - 55 : y + 56], meshes);
    }
  }

  function seek(seconds: number, reduced = false) {
    play.seek(seconds, reduced);
    for (const field of Object.keys(poseTracks) as (keyof typeof poseTracks)[])
      pose[field] = poseTracks[field].value;
    let index = times.length - 1;
    while (index > 0 && times[index] > seconds) index--;
    const { focus } = targets[index];
    const branchZoom =
      focus === 'octree' && tree?.closeBranch
        ? Math.max(0, Math.min(1, pose.depth - tree.closeBranch.level))
        : 0;
    const states = drawLayerStates(index, branchZoom);
    const views = drawViews(index, seconds, reduced);
    drawHud(index, branchZoom, states, views);
    placeCamera(index, branchZoom, states, views);
    meshes = projection.fit();
    for (const view of views.values()) view.project?.(projection.project);
    paintPins(views.get(focus));
    paintCallout(index, seconds, reduced);
  }

  seek(0);
  const cuts = new Set([...times, ...sectionLabelTimes, ...play.cuts]);
  return {
    seek,
    cuts,
    inspect: () => inspect(meshes),
    dispose: () => disposeSpace3dMeshes(scene),
    mesh: { scene, camera, width, height },
  };
}
