import type { Page } from 'playwright';

// Fixture instants, not execution deadlines. Pause on about:blank before application code loads.
const CLOCK_START = '1969-12-31T00:00:00.000Z';
const CLOCK_EPOCH = '1970-01-01T00:00:00.000Z';
// Playwright's installed clock schedules RAF on a 16 ms grid; preserve the two layout frames.
const LAYOUT_FRAMES_MS = 2 * 16;

/** Serialized by Playwright into the page and every newly attached visual frame. */
export function resetAtlasRandom() {
  let state = 1;
  // Numerical Recipes' 32-bit LCG: deterministic fixture sequence, not cryptographic randomness.
  Math.random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export async function installAtlasClock(page: Page) {
  await page.clock.install({ time: new Date(CLOCK_START) });
  await page.clock.pauseAt(new Date(CLOCK_EPOCH));
}

export async function resetAtlasSample(page: Page) {
  await page.clock.setSystemTime(new Date(CLOCK_EPOCH));
  await page.evaluate(resetAtlasRandom);
}

export async function advanceAtlasLayout(page: Page, timeSeconds = 0) {
  await page.clock.runFor(timeSeconds * 1000 + LAYOUT_FRAMES_MS);
}
