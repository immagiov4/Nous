export const WIDTH = 1000;
export const HEIGHT = 465;

// The lab's 1280 × 720 release stage has 34 px padding and a 16 px gap below its 17 px title.
const RELEASE_PADDING = 34;
export const RELEASE_SCALE = (1280 - 2 * RELEASE_PADDING) / WIDTH;
const RELEASE_HEIGHT = 720 - 2 * RELEASE_PADDING - 16 - Math.ceil(17 * 1.15);
const STUDIO_HEIGHT = Math.floor(RELEASE_HEIGHT / RELEASE_SCALE);
const chartViewport = { top: (HEIGHT - STUDIO_HEIGHT) / 2, height: STUDIO_HEIGHT };

export type StudioViewport = { width: number; height: number };

/** Plot rectangles measured in the reader and listening player, in CSS pixels. */
export const readerStudioViewports = {
  compactPhoneInline: { width: 252, height: 168 },
  compactPhone: { width: 284, height: 250.625 },
  phoneInline: { width: 322, height: 168 },
  phone: { width: 354, height: 526.625 },
  desktopInline: { width: 643.25, height: 326.765625 },
  desktop: { width: 589.671875, height: 370.640625 },
  desktopTall: { width: 675.453125, height: 550.640625 },
  desktopWide: { width: 1646.40625, height: 575.671875 },
  phoneFullscreen: { width: 780, height: 206.640625 },
} as const satisfies Record<string, StudioViewport>;

/** The reference layout remains available to callers that don't supply a reader viewport. */
export function studioStage(viewport?: StudioViewport) {
  return viewport
    ? { width: viewport.width, top: 0, height: viewport.height, bottom: viewport.height }
    : { width: WIDTH, ...chartViewport, bottom: chartViewport.top + chartViewport.height };
}

/** Preferred positions are fractions of each axis. Glyphs and clearance use pixels. */
export function studioAnchors(viewport?: StudioViewport) {
  return {
    x: (reference: number) => (viewport ? (reference * viewport.width) / WIDTH : reference),
    y: (reference: number) =>
      viewport
        ? ((reference - chartViewport.top) * viewport.height) / chartViewport.height
        : reference,
  };
}
