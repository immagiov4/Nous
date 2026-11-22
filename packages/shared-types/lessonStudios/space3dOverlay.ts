import { nearestClearBox } from './callouts';
import { diagram } from './chart';
import { type LayoutBounds, type LayoutElement, MIN_TEXT_GAP_PX } from './layoutValidation';
import { enclosingBoxes, isVisible, vectorBounds } from './vectorBounds';
import type { Point, VectorNode } from './vectorScene';

export function moveOverlay(node: VectorNode, [x, y]: Point) {
  node.x = x;
  node.y = y;
}

export function buildSpace3dOverlay(root: VectorNode, title: string) {
  const surface = diagram(root, title);
  if (!root.viewport) throw new Error('Space 3D needs a measured stage');
  const { width, height } = root.viewport;
  const stage = { left: 0, top: 0, right: width, bottom: height };

  const ids = new WeakMap<VectorNode, string>();
  let nextId = 0;
  function idFor(node: VectorNode) {
    const id = ids.get(node) ?? String(nextId++);
    ids.set(node, id);
    return id;
  }

  function placeCallout(
    callout: ReturnType<typeof import('./chart').pill>,
    target: Point,
    desired: Point,
    meshes: LayoutBounds[]
  ) {
    const halfWidth = callout.width / 2;
    const halfHeight = callout.height / 2;
    const [x, y] = desired;
    const preferred = {
      left: x - halfWidth,
      right: x + halfWidth,
      top: y - halfHeight + callout.group.y,
      bottom: y + halfHeight + callout.group.y,
    };
    const clear = clearPlacement(preferred, callout.group, meshes);
    callout.place(
      target,
      clear ? [clear.left + halfWidth, clear.top + halfHeight - callout.group.y] : desired
    );
  }

  function clearPlacement(
    preferred: LayoutBounds,
    node: VectorNode,
    meshes: LayoutBounds[],
    placingPin = false
  ) {
    const gap = MIN_TEXT_GAP_PX;
    const occupied = enclosingBoxes(surface)
      .filter(
        ({ element }) =>
          !within(element, node) &&
          !ignoredClearance(element) &&
          !(placingPin && insidePill(element))
      )
      .flatMap(({ boxes }) => boxes);
    return nearestClearBox(
      preferred,
      {
        left: gap,
        right: width - gap,
        top: gap,
        bottom: height - gap,
      },
      [...meshes, ...occupied].map(box => ({
        left: box.left - gap,
        right: box.right + gap,
        top: box.top - gap,
        bottom: box.bottom + gap,
      }))
    );
  }

  function placePin(node: VectorNode, meshes: LayoutBounds[]) {
    if (!isVisible(node)) return;
    const [ink] = vectorBounds(node);
    if (!ink) return;
    const clear = clearPlacement(ink, node, meshes, true);
    if (!clear) return;
    node.x += clear.left - ink.left;
    node.y += clear.top - ink.top;
  }

  function collectLabel(element: VectorNode, labels: string[]) {
    if (!element.label) return;
    const text = element.parent;
    if (!text?.parent?.parent?.hasClass('pill')) labels.push(element.textContent);
    else if (text.children[0] === element)
      labels.push(text.children.map(node => node.textContent).join(' '));
  }

  function inspect(meshes: LayoutBounds[]) {
    const labels: string[] = [];
    const elements: LayoutElement[] = meshes.map((box, index) => ({
      id: `mesh-${index}`,
      mark: true,
      bounds: box,
    }));
    const visibleInk = enclosingBoxes(surface).filter(({ element }) => !ignoredClearance(element));
    for (const { element, boxes } of visibleInk) {
      const id = idFor(element);
      const label = element.label ? { fontPx: element.label.size } : undefined;
      const body = element.parent?.parent;
      const chip = body?.parent?.hasClass('pill')
        ? body.children.find(node => node.tag === 'rect')
        : undefined;
      collectLabel(element, labels);
      for (const [index, box] of boxes.entries()) {
        elements.push({
          id: index ? `${id}-${index}` : id,
          bounds: box,
          label,
          containerId: chip && idFor(chip),
          mark: !label && !element.parent?.parent?.hasClass('pill'),
          motionState: label && element.textContent,
        });
      }
    }
    return { stage, elements, labels };
  }

  return { surface, width, height, inspect, placeCallout, placePin };
}

function within(node: VectorNode, ancestor: VectorNode) {
  for (let current: VectorNode | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function insidePill(node: VectorNode) {
  for (let current: VectorNode | undefined = node; current; current = current.parent) {
    if (current.hasClass('pill')) return true;
  }
  return false;
}

function ignoredClearance(node: VectorNode) {
  for (let current: VectorNode | undefined = node; current; current = current.parent) {
    if (Object.hasOwn(current.attrs, 'data-clearance-ignore')) return true;
  }
  return node.hasClass('leader');
}
