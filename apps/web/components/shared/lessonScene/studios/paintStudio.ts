import type { StudioTextShape } from '@shared/lessonStudios/studioTypography';
import { labelScaleX, type VectorNode } from '@shared/lessonStudios/vectorScene';

const SVG = 'http://www.w3.org/2000/svg';

function drawText(element: SVGElement, label: string, shape: StudioTextShape) {
  const title = document.createElementNS(SVG, 'title');
  title.textContent = label;
  const paths = shape.glyphs.map(({ path, x, y }) => {
    const glyph = document.createElementNS(SVG, 'path');
    glyph.setAttribute('d', path);
    glyph.setAttribute('transform', `translate(${x} ${y}) scale(${shape.scale} ${-shape.scale})`);
    return glyph;
  });
  element.replaceChildren(title, ...paths);
}

function updateAttributes(element: SVGElement, node: VectorNode, previous: Set<string>) {
  const attributes = { ...node.attrs };
  const x = node.x + (node.label ? node.number('x') : 0);
  const y = node.y + (node.label ? node.number('y') : 0);
  if (x || y) attributes.transform = `translate(${x} ${y})`;
  const stretch = node.label ? labelScaleX(node, node.glyphs().advance) : 1;
  if (stretch !== 1) attributes.transform = `translate(${x} ${y}) scale(${stretch} 1)`;
  if (node.label) attributes['data-font-units'] = node.label.size;
  if (node.opacity !== undefined) attributes.opacity = node.opacity;
  for (const [key, value] of Object.entries(node.data)) {
    const name = key.replaceAll(/[A-Z]/gu, char => `-${char.toLowerCase()}`);
    attributes[`data-${name}`] = value;
  }
  for (const name of previous) {
    if (!Object.hasOwn(attributes, name)) element.removeAttribute(name);
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (element.getAttribute(name) !== String(value)) element.setAttribute(name, String(value));
  }
  return new Set(Object.keys(attributes));
}

/** Render the checked geometry without reading layout from the DOM. */
export function mountStudio(parent: HTMLElement | SVGElement, node: VectorNode): () => void {
  const element = document.createElementNS(SVG, node.label ? 'g' : node.tag);
  parent.append(element);
  let childNodes = [...node.children];
  let children = childNodes.map(child => mountStudio(element, child));
  let previous = new Set<string>();
  let glyphs: StudioTextShape | undefined;
  return () => {
    previous = updateAttributes(element, node, previous);
    if (node.tag === 'title' && element.textContent !== node.textContent) {
      element.textContent = node.textContent;
    }
    if (node.label) {
      const shapes = node.glyphs();
      if (glyphs !== shapes) {
        drawText(element, node.textContent, shapes);
        glyphs = shapes;
      }
    }
    if (
      node.children.length !== childNodes.length ||
      node.children.some((child, index) => child !== childNodes[index])
    ) {
      element.replaceChildren();
      childNodes = [...node.children];
      children = childNodes.map(child => mountStudio(element, child));
    }
    for (const draw of children) draw();
  };
}
