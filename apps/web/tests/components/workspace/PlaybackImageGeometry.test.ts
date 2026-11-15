import { readFile } from 'node:fs/promises';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { withMutedAudio } from '../../../../../scripts/browser-audio';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch(withMutedAudio({ headless: true }));
});
afterAll(async () => {
  await browser?.close();
});

test.each([
  'playback',
  'dialog',
  'thumbnail',
])('keeps %s geometry through delayed image resolution and decoding', async surface => {
  const bytes = await readFile('apps/web/public/icons/nous-app-icon-mask-512.png');
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport });
      let release!: () => void;
      const pending = new Promise<void>(resolve => {
        release = resolve;
      });
      try {
        const requested = page.waitForRequest('**/api/projects/image-geometry/assets/*');
        await page.route('**/api/projects/image-geometry/assets/*', async route => {
          await pending;
          await route.fulfill({ status: 200, contentType: 'image/png', body: bytes });
        });
        await page.goto(
          `${inject('browserFixtureUrl')}tests/fixtures/imageGeometry.html?surface=${surface}${dark ? '&dark' : ''}`
        );
        await requested;
        await page.evaluate(() => document.fonts.ready);
        const measure = () =>
          page.evaluate(async surface => {
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            return [
              ...document.querySelectorAll(
                surface === 'playback' ? '.scene-fit, .scene-host figure' : '#root > div > *'
              ),
            ].map(e => {
              const r = e.getBoundingClientRect();
              return [r.left, r.top, r.width, r.height].map(Math.round);
            });
          }, surface);
        const before = await measure();
        expect(before).toEqual(await page.evaluate(() => window.imageGeometryInitial));
        if (surface === 'playback')
          expect(await page.evaluate(() => window.imageGeometryReady())).toBe(false);
        release();
        await page.locator('img[src^="blob:"]').waitFor();
        await page
          .locator('img[src^="blob:"]')
          .evaluate((image: HTMLImageElement) => image.decode());
        expect(await measure()).toEqual(before);
        if (surface === 'playback') {
          expect(await page.evaluate(() => window.imageGeometryReady())).toBe(true);
          if (viewport.width === 390)
            expect(
              await page.locator('.captions').evaluate(e => getComputedStyle(e).visibility)
            ).toBe('hidden');
        }
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
        await page.close();
      }
    }
  }
});
