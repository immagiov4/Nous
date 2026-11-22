import { automaticDuration, studioReaderCues } from '../lessonSceneAnimation';
import type { GeometryLessonScene, StudioLessonScene } from '../lessonSceneRegistry';
import { buildArray } from './array';
import { planCallouts } from './callouts';
import { RELEASE_SCALE, type StudioViewport, studioStage } from './chartDimensions';
import { buildFunctionPlot } from './functionPlot';
import { buildGraph } from './graph';
import { buildHeap } from './heapLayout';
import {
  checkStudioLayout,
  hasDeadStage,
  type LayoutElement,
  type StudioActiveWindow,
  type StudioCheck,
} from './layoutValidation';
import { type BuildMusicStaff, buildMusic } from './music';
import { buildPlane } from './plane';
import { buildTrajectories } from './trajectories';
import { enclosingBoxes, vectorOpacity } from './vectorBounds';
import { VectorNode } from './vectorScene';

const FRAMES_PER_SECOND = 20;

export function needsMusicStaff(scene: StudioLessonScene) {
  return (
    scene.type === 'geometry' &&
    scene.geometryStudio.id === 'music' &&
    scene.geometryStudio.spec.views.includes('staff')
  );
}

export async function loadMusicStaff() {
  return (await import('./musicStaff')).drawMusicStaff;
}

function buildGeometry(
  studio: GeometryLessonScene['geometryStudio'],
  root: VectorNode,
  cues: number[],
  staff?: BuildMusicStaff
) {
  switch (studio.id) {
    case 'graph':
      return buildGraph(studio.spec, root, cues);
    case 'function-plot':
      return buildFunctionPlot(studio.spec, root, cues);
    case 'plane':
      return buildPlane(studio.spec, root, cues);
    case 'trajectories':
      return buildTrajectories(studio.spec, root, cues);
    case 'music':
      return buildMusic(studio.spec, root, cues, staff);
  }
}

export function buildAlgorithmLayout(
  scene: StudioLessonScene,
  viewport?: StudioViewport,
  staff?: BuildMusicStaff
) {
  const durationMs = automaticDuration(scene);
  const cues = studioReaderCues(scene);
  const root = new VectorNode('root', {}, viewport);
  root.data.durationMs = String(durationMs);
  const motion = buildStudio(scene, root, cues, staff);
  const surface = root.children[0];
  let callouts: ReturnType<typeof planCallouts> | undefined;
  function seek(elapsedMs: number, reduced = false) {
    callouts ??= planCallouts(surface, motion, durationMs / 1000);
    const seconds = Math.min(durationMs, Math.max(0, elapsedMs)) / 1000;
    motion.seek(seconds, reduced);
    callouts(seconds);
  }
  return { surface, durationMs, cues, cuts: motion.cuts, seek };
}

function buildStudio(
  scene: StudioLessonScene,
  root: VectorNode,
  cues: number[],
  staff?: BuildMusicStaff
) {
  if (scene.type === 'geometry') return buildGeometry(scene.geometryStudio, root, cues, staff);
  const { studio } = scene;
  return studio.id === 'heap'
    ? buildHeap(studio.spec, root, cues)
    : buildArray(studio.spec, root, cues);
}

function layoutNodeIds() {
  const ids = new WeakMap<VectorNode, string>();
  let count = 0;
  return (node: VectorNode) => {
    const existing = ids.get(node);
    if (existing !== undefined) return existing;
    const id = String(count++);
    ids.set(node, id);
    return id;
  };
}

function pictureElements(
  surface: VectorNode,
  scale: number,
  idFor: ReturnType<typeof layoutNodeIds>,
  motionStateFor: (node: VectorNode) => string | undefined
): LayoutElement[] {
  return enclosingBoxes(surface).flatMap(({ element, boxes }) => {
    if (element.hasClass('leader')) return [];
    const id = idFor(element);
    const callout = element.parent?.parent?.parent;
    const label = element.label
      ? {
          fontPx: element.label.size * scale,
          association: callout?.data.calloutAnchor,
        }
      : undefined;
    const container = element.parent?.children.find(
      node =>
        node.tag === 'circle' ||
        (node.tag === 'rect' &&
          (element.parent?.hasClass('graph-node') ||
            element.parent?.hasClass('graph-verdict') ||
            element.parent?.hasClass('parameter-chip') ||
            element.parent?.attrs['data-label-container'] !== undefined))
    );
    const containerId = label && container ? idFor(container) : undefined;
    const isPill = element.tag === 'rect' && element.parent?.parent?.hasClass('callout');
    const motionState = motionStateFor(element);
    return boxes.map((box, index) => ({
      id: index ? `${id}-${index}` : id,
      bounds: {
        left: box.left * scale,
        top: box.top * scale,
        right: box.right * scale,
        bottom: box.bottom * scale,
      },
      label,
      containerId: containerId ?? (label ? pillContainer(element, idFor) : undefined),
      mark: !label && !isPill,
      motionState,
    }));
  });
}

function graphMotionState(node: VectorNode) {
  if (node.hasClass('graph-line') || node.hasClass('graph-pulse'))
    return `${vectorOpacity(node)}:${node.attrs['stroke-dashoffset'] ?? ''}`;
  if (
    node.hasClass('graph-distance') ||
    node.hasClass('graph-result') ||
    node.hasClass('graph-hud')
  )
    return node.textContent;
  if (node.tag === 'rect' && node.parent?.hasClass('graph-node'))
    return `${vectorOpacity(node)}:${node.parent.attrs['data-state'] ?? ''}`;
  return undefined;
}

function musicMotionState(node: VectorNode) {
  return `${vectorOpacity(node)}:${node.attrs['data-pitch'] === undefined ? '' : node.attrs.style}`;
}

function studioMotionState(scene: StudioLessonScene) {
  if (scene.type !== 'geometry') return () => undefined;
  switch (scene.geometryStudio.id) {
    case 'graph':
      return graphMotionState;
    case 'music':
      return musicMotionState;
    default:
      return () => undefined;
  }
}

function pillContainer(element: VectorNode, idFor: ReturnType<typeof layoutNodeIds>) {
  const body = element.parent?.parent;
  if (!body?.parent?.hasClass('pill')) return undefined;
  const rect = body.children.find(node => node.tag === 'rect');
  return rect ? idFor(rect) : undefined;
}

function geometryChanged(from: readonly LayoutElement[], to: readonly LayoutElement[]) {
  if (from.length !== to.length) return true;
  return from.some(({ bounds, motionState }, index) => {
    const { bounds: next, motionState: nextState } = to[index];
    return (
      motionState !== nextState ||
      bounds.left !== next.left ||
      bounds.top !== next.top ||
      bounds.right !== next.right ||
      bounds.bottom !== next.bottom
    );
  });
}

/** Inspect the same vector poses used by playback, including transitions and cue boundaries. */
export function checkAlgorithmGeometry(
  scene: StudioLessonScene,
  viewport?: StudioViewport,
  staff?: BuildMusicStaff
) {
  const layout = buildAlgorithmLayout(scene, viewport, staff);
  const { durationMs, cuts, surface } = layout;
  // A required label that cannot fit at construction time already disqualifies every pose.
  if (surface.data.unplacedRequiredLabel) return ['label-placement'] satisfies StudioCheck[];
  const scale = viewport ? 1 : RELEASE_SCALE;
  const step = 1000 / FRAMES_PER_SECOND;
  const samples = new Set([
    ...Array.from({ length: Math.ceil(durationMs / step) }, (_, index) => step * index),
    ...Array.from(cuts, seconds => seconds * 1000),
    durationMs,
  ]);
  const stageSize = studioStage(viewport);
  const stage = {
    left: 0,
    top: stageSize.top * scale,
    right: stageSize.width * scale,
    bottom: stageSize.bottom * scale,
  };
  const axisScale = surface.data.equalScale
    ? { x: Number(surface.data.planeUnitX), y: Number(surface.data.planeUnitY) }
    : undefined;
  const frames = [];
  const idFor = layoutNodeIds();
  const motionStateFor = studioMotionState(scene);
  const layoutProblems = new Set<StudioCheck>();
  const collectSurfaceChecks = () => {
    if (surface.data.unplacedRequiredLabel || surface.data.unplacedDiagramLabel)
      layoutProblems.add('label-placement');
    if (surface.data.unresolvedPlot) layoutProblems.add('plot-resolution');
  };
  const active: StudioActiveWindow[] = [];
  let previous: { time: number; marks: LayoutElement[] } | undefined;
  for (const time of [...samples].sort((a, b) => a - b)) {
    if (time < 0 || time > durationMs) continue;
    layout.seek(time);
    collectSurfaceChecks();
    const elements = pictureElements(surface, scale, idFor, motionStateFor);
    frames.push({ elements, axisScale });
    if (scene.type !== 'geometry') continue;
    const marks = elements.filter(element => element.mark || element.motionState !== undefined);
    if (previous && geometryChanged(previous.marks, marks))
      active.push({ startMs: previous.time, endMs: time });
    previous = { time, marks };
  }
  for (const seconds of cuts) {
    layout.seek(seconds * 1000, true);
    collectSurfaceChecks();
    frames.push({ elements: pictureElements(surface, scale, idFor, motionStateFor), axisScale });
  }
  const checks = [...checkStudioLayout({ stage, frames }), ...layoutProblems];
  if (
    scene.type === 'geometry' &&
    (active.length === 0 || hasDeadStage({ firstMeaningfulMs: 0, durationMs, active }))
  )
    checks.push('dead-stage');
  return checks;
}
