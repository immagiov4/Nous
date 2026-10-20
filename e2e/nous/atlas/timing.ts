import type { Page } from 'playwright';

// Fixture instants, not execution deadlines. Pause on about:blank before application code loads.
const CLOCK_START = '1969-12-31T00:00:00.000Z';
const CLOCK_EPOCH = '1970-01-01T00:00:00.000Z';
// Playwright's installed clock schedules RAF on a 16 ms grid; preserve the two layout frames.
export const ATLAS_FRAME_MS = 16;
const LAYOUT_FRAMES_MS = 2 * ATLAS_FRAME_MS;

/** Serialized by Playwright into the page and every newly attached visual frame. */
export function resetAtlasRandom() {
  let state = 1;
  // Numerical Recipes' 32-bit LCG: deterministic fixture sequence, not cryptographic randomness.
  Math.random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Frame creation must not expose the native performance clock before its first controlled tick. */
export function installAtlasFrameClock(frameMilliseconds: number) {
  const alignClock = (target: Performance) => {
    Object.defineProperties(target, {
      now: { configurable: true, value: () => Date.now() },
      timeOrigin: { configurable: true, value: 0 },
    });
  };
  let current = performance;
  // Playwright replaces this object; init-script order is unspecified. Keep its native timer source intact.
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    get: () => current,
    set: (replacement: Performance) => {
      current = replacement;
      alignClock(current);
    },
  });
  if (!(current instanceof Performance)) alignClock(current);
  const requestFrame = (callback: FrameRequestCallback) =>
    setTimeout(
      () => callback(performance.now()),
      frameMilliseconds - (Date.now() % frameMilliseconds)
    );
  const cancelFrame = (id: number) => clearTimeout(id);
  // Keep the fixture's RAF grid aligned to wall time when Playwright installs its clock in either order.
  Object.defineProperties(globalThis, {
    requestAnimationFrame: { configurable: true, get: () => requestFrame, set: () => undefined },
    cancelAnimationFrame: { configurable: true, get: () => cancelFrame, set: () => undefined },
  });
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

/** Entry imports can finish after the first probe while the fixture's RAF clock is paused. */
export async function waitForAtlasEntry(page: Page) {
  while (!(await page.evaluate(() => Boolean(window.playbackAtlas))))
    await advanceAtlasLayout(page);
}
