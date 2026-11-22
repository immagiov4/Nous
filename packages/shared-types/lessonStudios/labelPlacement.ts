import { isWithinCallout, nearestClearBox } from './callouts';
import { RELEASE_SCALE } from './chartDimensions';
import { MIN_TEXT_GAP_PX } from './layoutValidation';
import {
  type Box,
  boxDistance,
  enclosingBoxes,
  isLayoutBackdrop,
  isVisible,
  vectorBounds,
  vectorClip,
} from './vectorBounds';
import { descendants, type Point, type VectorNode } from './vectorScene';

const preferredPositions = new WeakMap<VectorNode, Point>();

/** Place the required free labels against the current marks before solving callouts. */
export function placeDiagramLabels(
  surface: VectorNode,
  classes: string[],
  area: Box,
  { keepUnplaced = false, anchorClass }: { keepUnplaced?: boolean; anchorClass?: string } = {}
) {
  const scale = surface.viewport ? 1 : RELEASE_SCALE;
  // Allow a pixel for the antialiasing around the measured ink.
  const clearance = (MIN_TEXT_GAP_PX + 1) / scale;
  const pad = ({ left, top, right, bottom }: Box): Box => ({
    left: left - clearance,
    top: top - clearance,
    right: right + clearance,
    bottom: bottom + clearance,
  });
  const labels = [...descendants(surface)].filter(
    node => node.label && classes.some(name => node.hasClass(name))
  );
  for (const node of labels) {
    const preferred = preferredPositions.get(node) ?? [node.number('x'), node.number('y')];
    preferredPositions.set(node, preferred);
    node.setAttribute('x', preferred[0]);
    node.setAttribute('y', preferred[1]);
    node.removeAttribute('visibility');
  }
  const movable = new Set(labels);
  const paint = enclosingBoxes(surface);
  const fixed = paint.flatMap(({ element, boxes }) =>
    movable.has(element) || isWithinCallout(element) || isLayoutBackdrop(element)
      ? []
      : boxes.map(pad)
  );
  const anchors = anchorClass ? paint.filter(({ element }) => element.hasClass(anchorClass)) : [];
  const placed: Box[] = [];
  delete surface.data.unplacedDiagramLabel;
  for (const label of labels) {
    if (!label.textContent.trim() || !isVisible(label)) continue;
    const [preferred] = vectorBounds(label, false);
    if (!preferred) continue;
    const anchor = anchors.find(({ element }) => element.parent?.parent === label.parent);
    const associated = (box: Box) => {
      if (Math.abs(box.left - preferred.left) >= 0.01) return false;
      if (!anchor) return false;
      const ownDistance = boxDistance(box, anchor.boxes[0]);
      return anchors.every(
        other => other === anchor || boxDistance(box, other.boxes[0]) > ownDistance
      );
    };
    const chosen = nearestClearBox(
      preferred,
      vectorClip(label, area) ?? area,
      [...fixed, ...placed],
      anchorClass ? associated : undefined
    );
    if (!chosen) {
      surface.data.unplacedDiagramLabel = 'true';
      if (!keepUnplaced) label.setAttribute('visibility', 'hidden');
      continue;
    }
    label.setAttribute('x', label.number('x') + chosen.left - preferred.left);
    label.setAttribute('y', label.number('y') + chosen.top - preferred.top);
    placed.push(pad(chosen));
  }
}
