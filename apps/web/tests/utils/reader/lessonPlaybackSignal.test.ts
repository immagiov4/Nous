import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { withMutedAudio } from '../../../../../scripts/browser-audio';
import type {} from '../../fixtures/audio-path';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch(withMutedAudio({ headless: true }));
  page = await browser.newPage();
  await page.goto(`${inject('browserFixtureUrl')}tests/fixtures/audio-path.html`);
  await page.waitForFunction(() => typeof window.renderUnity === 'function');
});
afterAll(async () => {
  await browser?.close();
});

test('unity playback is a native, sample-transparent path', async () => {
  const result = await page.evaluate(() => window.renderUnity());
  expect(result.error).toBe(0);
  expect(result.connections).toContain('AudioBufferSourceNode');
  expect(result.connections).not.toContain('AudioWorkletNode');
});

test.each([0.75, 1.25, 1.5])('processed playback at %sx stays within full scale', async speed => {
  const result = await page.evaluate(speed => window.renderProcessed({ speed }), speed);
  expect(result.peak).toBeGreaterThan(0.5);
  expect(result.peak).toBeLessThanOrEqual(1);
});

test('speed transitions keep position continuous and acoustic markers on the heard clock', async () => {
  const result = await page.evaluate(() =>
    window.renderProcessed({
      speed: 1,
      switches: [
        { at: 1, speed: 1.5 },
        { at: 1.75, speed: 1 },
      ],
      checkpoints: [1.31, 1.35, 2.1, 2.14],
    })
  );
  for (const clock of result.clock) expect(clock.after).toBe(clock.before);
  expect(result.cues.map(cue => cue.opacities)).toEqual([
    [0, 0],
    [1, 0],
    [1, 0],
    [1, 1],
  ]);
  // Marker words at source 1.5s and 2.5s; compare their first audible samples to the piecewise voice clock.
  expect(Math.abs(result.markers[0] - (1 + (1.5 - 1) / 1.5))).toBeLessThanOrEqual(1 / 60);
  expect(
    Math.abs(result.markers[1] - (result.clock[1].wall + 2.5 - result.clock[1].after))
  ).toBeLessThanOrEqual(1 / 60);
  expect(result.peak).toBeLessThanOrEqual(1);
});
