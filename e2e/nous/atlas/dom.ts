import type { Box } from './checks';

export interface AtlasDom {
  text: string;
  prose: string;
  mediaCount: number;
  mathCount: number;
  mounted: boolean;
  clips: { text: string; box: Box; boundary: Box; ancestor: string }[];
  canvasPixels: { width: number; height: number; paintedPixels: number | null }[];
  errors: string[];
}

/** Self-contained so Playwright can run the same inspection inside sandboxed frames. */
export function inspectAtlasDom(rootSelector: string): AtlasDom {
  const root = document.querySelector(rootSelector);
  if (!root) throw new Error('Atlas inspection root is missing.');
  const clips: AtlasDom['clips'] = [];
  const text: string[] = [];
  const prose: string[] = [];
  const stage = root.closest('.listening-stage');
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Playwright serializes this function without module closures.
  const boxOf = (rect: DOMRect): Box => ({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  });
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Playwright serializes this function without module closures.
  const painted = (element: Element) =>
    !element.closest('.sr-only, .katex-mathml, style, script, noscript') &&
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const inspectBox = (box: Box, element: Element, label: string) => {
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    if (
      box.left < viewport.left ||
      box.right > viewport.right ||
      box.top < viewport.top ||
      box.bottom > viewport.bottom
    ) {
      clips.push({ text: label, box, boundary: viewport, ancestor: 'viewport' });
    }

    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const rect = ancestor.getBoundingClientRect();
      const boundary = boxOf(rect);
      const clipX =
        ancestor === stage || ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);
      const clipY =
        ancestor === stage || ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY);
      if (!clipX) {
        boundary.left = box.left;
        boundary.right = box.right;
      }
      if (!clipY) {
        boundary.top = box.top;
        boundary.bottom = box.bottom;
      }
      if (
        box.left < boundary.left ||
        box.right > boundary.right ||
        box.top < boundary.top ||
        box.bottom > boundary.bottom
      ) {
        clips.push({ text: label, box, boundary, ancestor: ancestor.className.toString() });
      }
    }
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || !painted(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter(rect => rect.width && rect.height);
    if (!rects.length) continue;
    text.push(node.textContent);
    if (!parent.closest('.katex, math')) prose.push(node.textContent);
    for (const rect of rects) inspectBox(boxOf(rect), parent, node.textContent);
  }
  const media = Array.from(
    root.querySelectorAll('img, svg:not([aria-hidden="true"]), canvas, video')
  ).filter(element => {
    if (!painted(element) || element.closest('.katex, .meaning-icon')) return false;
    return (
      !(element instanceof SVGSVGElement) ||
      Boolean(
        element.querySelector(
          'path, rect, circle, ellipse, line, polyline, polygon, text, image, use, foreignObject'
        )
      )
    );
  });
  for (const element of media)
    inspectBox(boxOf(element.getBoundingClientRect()), element, element.tagName);
  for (const frame of root.querySelectorAll('iframe')) {
    inspectBox(boxOf(frame.getBoundingClientRect()), frame, 'iframe');
  }
  const errors = Array.from(root.querySelectorAll('img'))
    .filter(image => image.complete && !image.naturalWidth)
    .map(() => 'Image failed to decode.');
  errors.push(
    ...Array.from(
      root.querySelectorAll('[role="alert"], output[aria-busy="false"]'),
      element => element.textContent ?? 'Visual rendering failed.'
    )
  );
  const emptyCanvases = new Set<Element>();
  const canvasPixels = Array.from(root.querySelectorAll('canvas'), canvas => {
    let paintedPixels: number | null = null;
    try {
      const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (pixels) {
        paintedPixels = 0;
        for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha]) paintedPixels++;
        if (!paintedPixels) emptyCanvases.add(canvas);
      }
    } catch {
      /* Sandboxed or non-2D canvases retain unavailable occupancy as raw evidence. */
    }
    return { width: canvas.width, height: canvas.height, paintedPixels };
  });
  return {
    text: text.join(' '),
    prose: prose.join(' '),
    mediaCount: media.filter(element => !emptyCanvases.has(element)).length,
    mathCount: root.querySelectorAll('.katex, math:not(.katex-mathml math)').length,
    mounted: Boolean(root.childElementCount),
    clips,
    canvasPixels,
    errors,
  };
}

/** Self-contained measurement for Playwright's locator evaluation. */
export function inspectAtlasGeometry(element: Element) {
  const scale =
    Number.parseFloat(
      getComputedStyle(element.parentElement as Element).getPropertyValue('--scene-scale')
    ) || 1;
  const fonts = Array.from(element.querySelectorAll('*'))
    .filter(child => child.textContent?.trim() && child.checkVisibility({ checkOpacity: true }))
    .map(child => Number.parseFloat(getComputedStyle(child).fontSize) * scale);
  return { sceneScale: scale, minFontPx: fonts.length ? Math.min(...fonts) : null };
}
