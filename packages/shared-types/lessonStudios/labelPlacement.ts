import { isWithinCallout, nearestClearBox } from './callouts';
import { RELEASE_SCALE, studioViewportScale } from './chartDimensions';
import { MIN_TEXT_GAP_PX } from './layoutValidation';
import { type Box, enclosingBoxes, isVisible, vectorBounds, vectorClip } from './vectorBounds';
import { descendants, type Point, type VectorNode } from './vectorScene';

const preferredPositions = new WeakMap<VectorNode, Point>();

/** Place the required free labels against the current marks before solving callouts. */
export function placeDiagramLabels(
  surface: VectorNode,
  classes: string[],
  area: Box,
  ownPaint: (label: VectorNode, mark: VectorNode) => boolean
) {
  const scale = surface.viewport ? studioViewportScale(surface.viewport) : RELEASE_SCALE;
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
  const paint = enclosingBoxes(surface).filter(
    ({ element }) => !movable.has(element) && !isWithinCallout(element)
  );
  const placed: Box[] = [];
  if (classes.includes('plane-label')) delete surface.data.unplacedDiagramLabel;
  for (const label of labels) {
    if (!label.textContent.trim() || !isVisible(label)) continue;
    const [preferred] = vectorBounds(label, false);
    if (!preferred) continue;
    const fixed = paint.flatMap(({ element, boxes }) =>
      ownPaint(label, element) ? [] : boxes.map(pad)
    );
    const chosen = nearestClearBox(preferred, vectorClip(label, area) ?? area, [
      ...fixed,
      ...placed,
    ]);
    if (!chosen) {
      if (label.hasClass('plane-label')) surface.data.unplacedDiagramLabel = 'true';
      label.setAttribute('visibility', 'hidden');
      continue;
    }
    label.setAttribute('x', label.number('x') + chosen.left - preferred.left);
    label.setAttribute('y', label.number('y') + chosen.top - preferred.top);
    placed.push(pad(chosen));
  }
}
