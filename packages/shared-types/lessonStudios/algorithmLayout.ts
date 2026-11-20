import { algorithmReaderCues, automaticDuration } from '../lessonSceneAnimation';
import type { AlgorithmLessonScene } from '../lessonSceneRegistry';
import { buildArray } from './array';
import { planCallouts } from './callouts';
import { chartViewport, RELEASE_SCALE, WIDTH } from './chart';
import { buildHeap } from './heapLayout';
import { checkStudioLayout, type LayoutElement } from './layoutValidation';
import { enclosingBoxes } from './vectorBounds';
import { descendants, VectorNode } from './vectorScene';

const FRAMES_PER_SECOND = 20;

export function buildAlgorithmLayout(scene: AlgorithmLessonScene) {
  const durationMs = automaticDuration(scene);
  const cues = algorithmReaderCues(scene);
  const root = new VectorNode('root');
  root.data.durationMs = String(durationMs);
  const { studio } = scene;
  const motion =
    studio.id === 'heap' ? buildHeap(studio.spec, root, cues) : buildArray(studio.spec, root, cues);
  const surface = root.children[0];
  const callouts = planCallouts(surface, motion, durationMs / 1000);
  function seek(elapsedMs: number, reduced = false) {
    const seconds = Math.min(durationMs, Math.max(0, elapsedMs)) / 1000;
    motion.seek(seconds, reduced);
    callouts(seconds);
  }
  return { surface, durationMs, cues, cuts: motion.cuts, seek };
}

function pictureElements(surface: VectorNode, ids: Map<VectorNode, string>): LayoutElement[] {
  return enclosingBoxes(surface).flatMap(({ element, boxes }) => {
    if (element.hasClass('leader')) return [];
    const id = ids.get(element)!;
    const callout = element.parent?.parent?.parent;
    const label = element.label
      ? {
          fontPx: element.label.size * RELEASE_SCALE,
          association: callout?.data.calloutAnchor,
        }
      : undefined;
    const container = element.parent?.children.find(node => node.tag === 'circle');
    const containerId = label && container ? ids.get(container) : undefined;
    const isPill = element.tag === 'rect' && element.parent?.parent?.hasClass('callout');
    return boxes.map((box, index) => ({
      id: index ? `${id}-${index}` : id,
      bounds: {
        left: box.left * RELEASE_SCALE,
        top: box.top * RELEASE_SCALE,
        right: box.right * RELEASE_SCALE,
        bottom: box.bottom * RELEASE_SCALE,
      },
      label,
      containerId: containerId ?? (label ? pillContainer(element, ids) : undefined),
      mark: !label && !isPill,
    }));
  });
}

function pillContainer(element: VectorNode, ids: Map<VectorNode, string>) {
  const body = element.parent?.parent;
  if (!body?.parent?.hasClass('callout')) return undefined;
  const rect = body.children.find(node => node.tag === 'rect');
  return rect ? ids.get(rect) : undefined;
}

/** Inspect the same vector poses used by playback, including transitions and cue boundaries. */
export function checkAlgorithmGeometry(scene: AlgorithmLessonScene) {
  const layout = buildAlgorithmLayout(scene);
  const { durationMs, cuts, surface } = layout;
  const step = 1000 / FRAMES_PER_SECOND;
  const samples = new Set([
    ...Array.from({ length: Math.ceil(durationMs / step) }, (_, index) => step * index),
    ...Array.from(cuts, seconds => seconds * 1000),
    durationMs,
  ]);
  const ids = new Map(Array.from(descendants(surface), (node, index) => [node, String(index)]));
  const stage = {
    left: 0,
    top: chartViewport.top * RELEASE_SCALE,
    right: WIDTH * RELEASE_SCALE,
    bottom: (chartViewport.top + chartViewport.height) * RELEASE_SCALE,
  };
  const frames = [];
  for (const time of samples) {
    if (time < 0 || time > durationMs) continue;
    layout.seek(time);
    frames.push({ elements: pictureElements(surface, ids) });
  }
  for (const seconds of cuts) {
    layout.seek(seconds * 1000, true);
    frames.push({ elements: pictureElements(surface, ids) });
  }
  return checkStudioLayout({ stage, frames });
}
