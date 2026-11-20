import { automaticDuration, studioReaderCues } from '../lessonSceneAnimation';
import type { GeometryLessonScene, StudioLessonScene } from '../lessonSceneRegistry';
import { buildArray } from './array';
import { planCallouts } from './callouts';
import {
  chartViewport,
  readerStudioViewports,
  type StudioViewport,
  studioViewportScale,
  WIDTH,
} from './chartDimensions';
import { buildHeap } from './heapLayout';
import {
  checkStudioLayout,
  hasDeadStage,
  type LayoutElement,
  type StudioActiveWindow,
} from './layoutValidation';
import { buildPlane } from './plane';
import { buildTrajectories } from './trajectories';
import { enclosingBoxes } from './vectorBounds';
import { VectorNode } from './vectorScene';

const FRAMES_PER_SECOND = 20;

export function buildAlgorithmLayout(scene: AlgorithmLessonScene, viewport?: StudioViewport) {
  const durationMs = automaticDuration(scene);
  const cues = algorithmReaderCues(scene);
  const root = new VectorNode('root', {}, viewport);
  root.data.durationMs = String(durationMs);
  const motion = buildStudio(scene, root, cues);
  const surface = root.children[0];
  const callouts = planCallouts(surface, motion, durationMs / 1000);
  function seek(elapsedMs: number, reduced = false) {
    const seconds = Math.min(durationMs, Math.max(0, elapsedMs)) / 1000;
    motion.seek(seconds, reduced);
    callouts(seconds);
  }
  return { surface, durationMs, cues, cuts: motion.cuts, seek };
}

function pictureElements(
  surface: VectorNode,
  ids: Map<VectorNode, string>,
  scale: number
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
            element.parent?.hasClass('parameter-chip')))
    );
    const containerId = label && container ? idFor(container) : undefined;
    const isPill = element.tag === 'rect' && element.parent?.parent?.hasClass('callout');
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
    }));
  });
}

function pillContainer(element: VectorNode, idFor: ReturnType<typeof layoutNodeIds>) {
  const body = element.parent?.parent;
  if (!body?.parent?.hasClass('pill')) return undefined;
  const rect = body.children.find(node => node.tag === 'rect');
  return rect ? idFor(rect) : undefined;
}

function geometryChanged(from: readonly LayoutElement[], to: readonly LayoutElement[]) {
  if (from.length !== to.length) return true;
  return from.some(({ bounds }, index) => {
    const next = to[index].bounds;
    return (
      bounds.left !== next.left ||
      bounds.top !== next.top ||
      bounds.right !== next.right ||
      bounds.bottom !== next.bottom
    );
  });
}

/** Inspect the same vector poses used by playback, including transitions and cue boundaries. */
export function checkAlgorithmGeometry(
  scene: AlgorithmLessonScene,
  viewport: StudioViewport = readerStudioViewports.phone
) {
  const layout = buildAlgorithmLayout(scene, viewport);
  const scale = studioViewportScale(viewport);
  const { durationMs, cuts, surface } = layout;
  const step = 1000 / FRAMES_PER_SECOND;
  const samples = new Set([
    ...Array.from({ length: Math.ceil(durationMs / step) }, (_, index) => step * index),
    ...Array.from(cuts, seconds => seconds * 1000),
    durationMs,
  ]);
  const stage = {
    left: 0,
    top: chartViewport.top * scale,
    right: WIDTH * scale,
    bottom: (chartViewport.top + chartViewport.height) * scale,
  };
  const axisScale = surface.data.equalScale
    ? { x: Number(surface.data.planeUnitX), y: Number(surface.data.planeUnitY) }
    : undefined;
  const frames = [];
  const idFor = layoutNodeIds();
  let lostRequiredLabel = false;
  const inspect = () => {
    lostRequiredLabel ||= surface.data.unplacedRequiredLabel === 'true';
    return { elements: pictureElements(surface, ids, scale) };
  };
  for (const time of samples) {
    if (time < 0 || time > durationMs) continue;
    layout.seek(time);
    frames.push(inspect());
  }
  for (const seconds of cuts) {
    layout.seek(seconds * 1000, true);
    frames.push(inspect());
  }
  const checks = checkStudioLayout({ stage, frames });
  if (lostRequiredLabel) checks.push('label-placement');
  return checks;
}
