import { nearestClearBox } from './callouts';
import { textAt as chartText, diagram } from './chart';
import { chartViewport, RELEASE_SCALE, studioViewportScale, WIDTH } from './chartDimensions';
import { type LayoutBounds, type LayoutElement, MIN_TEXT_GAP_PX } from './layoutValidation';
import type { StudioAnchor, StudioTextStyle } from './studioTypography';
import { enclosingBoxes, isVisible, vectorBounds } from './vectorBounds';
import {
  type Point,
  svg,
  type VectorAttributes,
  type VectorNode,
  type VectorTag,
} from './vectorScene';

export function overlayMark(parent: VectorNode, tag: VectorTag, attrs: VectorAttributes) {
  return svg(parent, tag, attrs);
}

export function moveOverlay(node: VectorNode, [x, y]: Point) {
  node.x = x;
  node.y = y;
}

export function textAt(
  parent: VectorNode,
  x: number,
  y: number,
  text: string,
  anchor: StudioAnchor = 'middle',
  style: StudioTextStyle = 'axis-label'
) {
  return chartText(parent, x, y, text, anchor, style);
}

export function buildSpace3dOverlay(root: VectorNode, title: string) {
  const surface = diagram(root, title);
  const scale = root.viewport ? studioViewportScale(root.viewport) : RELEASE_SCALE;
  const width = WIDTH * scale;
  const height = chartViewport.height * scale;
  const stage = { left: 0, top: 0, right: width, bottom: height };

  function cssBounds(box: LayoutBounds): LayoutBounds {
    return {
      left: box.left * scale,
      right: box.right * scale,
      top: (box.top - chartViewport.top) * scale,
      bottom: (box.bottom - chartViewport.top) * scale,
    };
  }

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
      top: y - halfHeight,
      bottom: y + halfHeight,
    };
    const clear = clearPlacement(preferred, callout.group, meshes);
    callout.place(target, clear ? [clear.left + halfWidth, clear.top + halfHeight] : desired);
  }

  function clearPlacement(preferred: LayoutBounds, node: VectorNode, meshes: LayoutBounds[]) {
    const gap = MIN_TEXT_GAP_PX / scale;
    const occupied = enclosingBoxes(surface)
      .filter(({ element }) => !within(element, node) && !ignoredClearance(element))
      .flatMap(({ boxes }) => boxes);
    return nearestClearBox(
      preferred,
      {
        left: 8,
        right: WIDTH - 8,
        top: chartViewport.top + 8,
        bottom: chartViewport.top + chartViewport.height - 8,
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
    const clear = clearPlacement(ink, node, meshes);
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
      bounds: cssBounds(box),
    }));
    for (const { element, boxes } of enclosingBoxes(surface)) {
      if (ignoredClearance(element)) continue;
      const id = idFor(element);
      const label = element.label ? { fontPx: element.label.size * scale } : undefined;
      const body = element.parent?.parent;
      const chip = body?.parent?.hasClass('pill')
        ? body.children.find(node => node.tag === 'rect')
        : undefined;
      collectLabel(element, labels);
      for (const [index, box] of boxes.entries()) {
        elements.push({
          id: index ? `${id}-${index}` : id,
          bounds: cssBounds(box),
          label,
          containerId: chip && idFor(chip),
          mark: !label && !element.parent?.parent?.hasClass('pill'),
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

function ignoredClearance(node: VectorNode) {
  for (let current: VectorNode | undefined = node; current; current = current.parent) {
    if (Object.hasOwn(current.attrs, 'data-clearance-ignore')) return true;
  }
  return node.hasClass('leader');
}
