import { svgPathProperties } from 'svg-path-properties';
import type { VectorNode } from './vectorScene';

type Path = InstanceType<typeof svgPathProperties>;
const paths = new WeakMap<VectorNode, { source: string; path: Path }>();

/** The geometry of a path in chart units, independently of the browser. */
export function vectorPath(node: VectorNode): Path {
  const source = String(node.attrs.d ?? '');
  const cached = paths.get(node);
  if (cached?.source === source) return cached.path;
  const path = new svgPathProperties(source);
  paths.set(node, { source, path });
  return path;
}
