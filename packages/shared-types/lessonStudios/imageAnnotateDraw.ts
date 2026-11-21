import { readerStudioViewports, type StudioViewport } from './chartDimensions';
import { buildImageAnnotateLayout, checkImageAnnotateLayout } from './imageAnnotate';
import type { ImageAnnotateSpec } from './imageAnnotateSpec';
import { type LayoutBounds, MIN_TEXT_PX } from './layoutValidation';
import { svg, VectorNode } from './vectorScene';

function rectangle(bounds: LayoutBounds) {
  return {
    x: bounds.left,
    y: bounds.top,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  };
}

function outline(bounds: LayoutBounds) {
  const { x, y, width, height } = rectangle(bounds);
  return `M${x} ${y}h${width}v${height}h${-width}Z`;
}

export function checkImageAnnotation(
  spec: ImageAnnotateSpec,
  cues: readonly number[],
  viewport: StudioViewport = readerStudioViewports.desktop
) {
  return checkImageAnnotateLayout(buildImageAnnotateLayout(spec, cues, viewport));
}

/** A viewport-sized vector surface makes measured Inter pixels equal rendered CSS pixels. */
export function drawImageAnnotation(
  spec: ImageAnnotateSpec,
  cues: number[],
  viewport: StudioViewport,
  imageUrl?: string
) {
  const layout = buildImageAnnotateLayout(spec, cues, viewport);
  const surface = new VectorNode(
    'svg',
    {
      class: 'chart image-annotation-chart',
      role: 'img',
      'aria-label': spec.alt,
      viewBox: `0 0 ${viewport.width} ${viewport.height}`,
    },
    viewport
  );
  const clipped = svg(surface, 'svg', { class: 'image-annotation-clip' });
  const backdrop = svg(clipped, 'rect', { class: 'image-annotation-backdrop' });
  const image = svg(clipped, 'image', { preserveAspectRatio: 'none', href: imageUrl ?? '' });
  const shade = svg(clipped, 'path', { 'fill-rule': 'evenodd', class: 'image-annotation-shade' });
  const focus = svg(clipped, 'rect', { class: 'image-annotation-focus' });
  const guides =
    spec.overlay?.from.map(() => svg(clipped, 'line', { class: 'image-annotation-guide' })) ?? [];
  const point = svg(clipped, 'circle', { r: 3, class: 'image-annotation-point' });
  const labelGroup = svg(surface, 'g', {});
  const label = svg(labelGroup, 'text', { class: 'image-annotation-label' });
  label.label = { style: 'pill-text', size: MIN_TEXT_PX, anchor: 'middle' };

  return {
    surface,
    cuts: cues.map(cue => cue / 1000),
    seek(time: number, reduced: boolean) {
      const frame = layout.frameAt(time, reduced);
      const clip = rectangle(frame.clip);
      Object.assign(clipped.attrs, clip, {
        viewBox: [clip.x, clip.y, clip.width, clip.height].join(' '),
        style: `width:${clip.width}px;height:${clip.height}px;overflow:hidden`,
      });
      Object.assign(backdrop.attrs, clip);
      Object.assign(image.attrs, rectangle(frame.image));
      shade.attrs.d = frame.focus ? outline(frame.clip) + outline(frame.focus) : '';
      shade.opacity = frame.shade;
      focus.attrs.visibility = frame.focus ? 'visible' : 'hidden';
      if (frame.focus) Object.assign(focus.attrs, rectangle(frame.focus));
      guides.forEach((guide, index) => {
        const ray = frame.rays[index];
        guide.attrs.visibility = ray ? 'visible' : 'hidden';
        if (ray)
          Object.assign(guide.attrs, {
            x1: ray.from[0],
            y1: ray.from[1],
            x2: ray.to[0],
            y2: ray.to[1],
          });
      });
      point.attrs.visibility = frame.point ? 'visible' : 'hidden';
      if (frame.point) Object.assign(point.attrs, { cx: frame.point[0], cy: frame.point[1] });
      labelGroup.attrs.visibility = frame.label ? 'visible' : 'hidden';
      if (frame.label) {
        const { text, x, y } = frame.label;
        Object.assign(label.attrs, { x, y });
        label.textContent = text;
      }
    },
  };
}
