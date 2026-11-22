import {
  automaticDuration,
  type SceneAnimationFrame,
  studioReaderCues,
} from '../lessonSceneAnimation';
import type { GeometryLessonScene, StudioLessonScene } from '../lessonSceneRegistry';
import { algorithmHasDeadStage } from './algorithm';
import { buildArray } from './array';
import { planCallouts } from './callouts';
import { RELEASE_SCALE, type StudioViewport, studioStage } from './chartDimensions';
import { buildFunctionPlot } from './functionPlot';
import { buildGraph } from './graph';
import { buildHeap } from './heapLayout';
import {
  collectStudioFrameProblems,
  hasDeadStage,
  type LayoutElement,
  type StudioActiveWindow,
  type StudioCheck,
} from './layoutValidation';
import { buildPlane } from './plane';
import {
  createHoldPainter,
  planStudioHolds,
  studioBeatsStayInSync,
  validatedStudioHolds,
} from './studioBeatSync';
import { buildTrajectories } from './trajectories';
import { enclosingBoxes, isLayoutBackdrop, vectorOpacity } from './vectorBounds';
import { VectorNode } from './vectorScene';

const FRAMES_PER_SECOND = 20;

function buildGeometry(
  studio: GeometryLessonScene['geometryStudio'],
  root: VectorNode,
  cues: number[]
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
  }
}

export function buildAlgorithmLayout(scene: StudioLessonScene, viewport?: StudioViewport) {
  const durationMs = automaticDuration(scene);
  const cues = studioReaderCues(scene);
  const root = new VectorNode('root', {}, viewport);
  root.data.durationMs = String(durationMs);
  const motion = buildStudio(scene, root, cues);
  const surface = root.children[0];
  const holds = planStudioHolds(scene.studioCues, cues, durationMs);
  const markHold = holds.length ? createHoldPainter(surface, holds) : undefined;
  let callouts: ReturnType<typeof planCallouts> | undefined;
  function seek(elapsedMs: number, reduced = false, frame?: SceneAnimationFrame) {
    callouts ??= planCallouts(surface, motion, durationMs / 1000);
    const seconds = Math.min(durationMs, Math.max(0, elapsedMs)) / 1000;
    motion.seek(seconds, reduced);
    callouts(seconds);
    markHold?.(seconds * 1000, frame, true);
  }
  return { surface, durationMs, cues, cuts: motion.cuts, seek, holds, refreshHold: markHold };
}

function buildStudio(scene: StudioLessonScene, root: VectorNode, cues: number[]) {
  if (scene.type === 'geometry') return buildGeometry(scene.geometryStudio, root, cues);
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
  trackMotion: GeometryLessonScene['geometryStudio']['id'] | undefined
): LayoutElement[] {
  return enclosingBoxes(surface).flatMap(({ element, boxes }) => {
    if (element.hasClass('leader') || element.parent?.hasClass('grid')) return [];
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
            element.parent?.hasClass('parameter-chip')))
    );
    const containerId = label && container ? idFor(container) : undefined;
    const isPill = element.tag === 'rect' && element.parent?.parent?.hasClass('callout');
    const badgeEdge = callout?.hasClass('graph-edge-label') ? callout.parent : undefined;
    const edge = element.parent?.hasClass('graph-edge') ? element.parent : badgeEdge;
    const motionState = markMotionState(element, trackMotion);
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
      underlay: isLayoutBackdrop(element),
      edgeId: edge ? idFor(edge) : undefined,
      motionState,
    }));
  });
}

function markMotionState(
  node: VectorNode,
  studio: GeometryLessonScene['geometryStudio']['id'] | undefined
) {
  if (studio === 'graph') return graphMotionState(node);
  if (studio === 'plane' && node.parent?.attrs['data-layer'] !== undefined && !node.label)
    return `${vectorOpacity(node)}:${node.attrs.d ?? ''}`;
  return undefined;
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

function collectSurfaceProblems(surface: VectorNode, problems: Set<StudioCheck>) {
  if (surface.data.unplacedRequiredLabel || surface.data.unplacedDiagramLabel)
    problems.add('label-placement');
  if (surface.data.unresolvedPlot) problems.add('plot-resolution');
}

function sampleGeometryMotion(
  times: number[],
  inspectPose: (time: number) => LayoutElement[]
): StudioActiveWindow[] {
  const active: StudioActiveWindow[] = [];
  let previous: { time: number; marks: LayoutElement[] } | undefined;
  for (const time of times) {
    const marks = inspectPose(time).filter(
      element => element.mark || element.motionState !== undefined
    );
    if (previous && geometryChanged(previous.marks, marks))
      active.push({ startMs: previous.time, endMs: time });
    previous = { time, marks };
  }
  return active;
}

/** Inspect the same vector poses used by playback, including transitions and cue boundaries. */
export function checkAlgorithmGeometry(
  scene: StudioLessonScene,
  viewport?: StudioViewport,
  requireBeatSync = false
) {
  const layout = buildAlgorithmLayout(scene, viewport);
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
  let hasElements = false;
  const problems = new Set<StudioCheck>();
  const idFor = layoutNodeIds();
  const trackMotion = scene.type === 'geometry' ? scene.geometryStudio.id : undefined;
  const layoutProblems = new Set<StudioCheck>();
  const inspectPose = (time: number, reduced = false) => {
    layout.seek(time, reduced);
    collectSurfaceProblems(surface, layoutProblems);
    const elements = pictureElements(surface, scale, idFor, trackMotion);
    hasElements ||= elements.length > 0;
    collectStudioFrameProblems(stage, { elements, axisScale }, problems);
    return elements;
  };
  const orderedSamples = [...samples]
    .filter(time => time >= 0 && time <= durationMs)
    .sort((a, b) => a - b);
  const active = trackMotion ? sampleGeometryMotion(orderedSamples, inspectPose) : [];
  if (!trackMotion)
    orderedSamples.forEach(time => {
      inspectPose(time);
    });
  for (const seconds of cuts) inspectPose(seconds * 1000, true);
  const checks: StudioCheck[] = [
    ...(hasElements ? problems : (['layout-unavailable'] as const)),
    ...layoutProblems,
  ];
  const holds = validatedStudioHolds(layout, orderedSamples);
  const deadStage =
    scene.type === 'geometry'
      ? hasDeadStage({ firstMeaningfulMs: 0, durationMs, active: [...active, ...holds] }) ||
        (active.length === 0 && holds.length === 0)
      : (requireBeatSync || layout.holds.length > 0) &&
        algorithmHasDeadStage(scene, durationMs, holds);
  if (
    deadStage ||
    holds.length !== layout.holds.length ||
    (requireBeatSync && !studioBeatsStayInSync(scene, layout))
  )
    checks.push('dead-stage');
  return checks;
}
