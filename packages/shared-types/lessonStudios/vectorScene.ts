import type { StudioViewport } from './chartDimensions';
import type { LayoutBounds } from './layoutValidation';
import {
  type StudioAnchor,
  type StudioTextShape,
  type StudioTextStyle,
  studioTextShape,
} from './studioTypography';

export type Point = [number, number];
export type VectorTag =
  | 'root'
  | 'svg'
  | 'g'
  | 'rect'
  | 'circle'
  | 'ellipse'
  | 'line'
  | 'polyline'
  | 'text'
  | 'path'
  | 'title'
  | 'defs'
  | 'linearGradient'
  | 'stop'
  | 'marker'
  | 'image';
export type VectorAttributes = Record<string, string | number>;

/** The small set of SVG primitives authored by the sort engines. */
export class VectorNode {
  readonly children: VectorNode[] = [];
  readonly data: Record<string, string> = {};
  textContent = '';
  x = 0;
  y = 0;
  opacity: number | undefined;
  parent: VectorNode | undefined;
  label: { style: StudioTextStyle; anchor: StudioAnchor; size: number } | undefined;
  private previousText = '';
  private previousSize = 0;
  private shape: StudioTextShape | undefined;

  constructor(
    readonly tag: VectorTag,
    readonly attrs: VectorAttributes = {},
    readonly viewport?: StudioViewport
  ) {}

  append(node: VectorNode) {
    node.parent = this;
    this.children.push(node);
  }

  setAttribute(name: string, value: string | number) {
    this.attrs[name] = value;
  }

  removeAttribute(name: string) {
    delete this.attrs[name];
  }

  number(name: string) {
    return Number(this.attrs[name] ?? 0);
  }

  hasClass(name: string) {
    return String(this.attrs.class ?? '')
      .split(/\s+/u)
      .includes(name);
  }

  glyphs(): StudioTextShape {
    if (!this.label) throw new Error('Vector label requires typography');
    const { style, anchor, size } = this.label;
    if (this.shape && this.previousText === this.textContent && this.previousSize === size)
      return this.shape;
    this.previousText = this.textContent;
    this.previousSize = size;
    this.shape = studioTextShape(this.textContent, style, anchor, size);
    return this.shape;
  }
}

export function svg(parent: VectorNode, name: VectorTag, attrs: VectorAttributes) {
  const node = new VectorNode(name, attrs, parent.viewport);
  parent.append(node);
  return node;
}

export function* descendants(node: VectorNode): Iterable<VectorNode> {
  for (const child of node.children) {
    yield child;
    yield* descendants(child);
  }
}

export function absolutePosition(node: VectorNode | undefined): Point {
  let x = 0;
  let y = 0;
  for (let current = node; current; current = current.parent) {
    x += current.x;
    y += current.y;
  }
  return [x, y];
}

export function shiftBounds(bounds: LayoutBounds, [x, y]: Point): LayoutBounds {
  return {
    left: bounds.left + x,
    right: bounds.right + x,
    top: bounds.top + y,
    bottom: bounds.bottom + y,
  };
}

export function labelScaleX(node: VectorNode, advance: number) {
  const width = node.number('textLength');
  return width > 0 && advance > width ? width / advance : 1;
}
