export const WIDTH = 1000;
export const HEIGHT = 465;

// The lab's 1280 × 720 release stage has 34 px padding and a 16 px gap below its 17 px title.
const RELEASE_PADDING = 34;
export const RELEASE_SCALE = (1280 - 2 * RELEASE_PADDING) / WIDTH;
const RELEASE_HEIGHT = 720 - 2 * RELEASE_PADDING - 16 - Math.ceil(17 * 1.15);
const STUDIO_HEIGHT = Math.floor(RELEASE_HEIGHT / RELEASE_SCALE);
export const chartViewport = { top: (HEIGHT - STUDIO_HEIGHT) / 2, height: STUDIO_HEIGHT };

export type StudioViewport = { width: number; height: number };

/** Plot rectangles measured in the desktop and phone lesson readers, in CSS pixels. */
export const readerStudioViewports = {
  desktop: { width: 403, height: 204.71875 },
  phone: { width: 274, height: 139.1875 },
} as const satisfies Record<string, StudioViewport>;

/** Use the same uniform transform as the SVG view box in its displayed rectangle. */
export function studioViewportScale({ width, height }: StudioViewport) {
  return Math.min(width / WIDTH, height / chartViewport.height);
}
