import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox, type Page } from 'playwright';
import { build, preview } from 'vite';
import { withMutedAudio } from '../../../../../scripts/browser-audio';
import viteConfig from '../../../vite.config';

// Inspect glyph bounds on every animation frame, including smooth-scroll intermediate positions.
async function visibleCaptionRows(page: Page) {
  return page.evaluate(async () => {
    const violations: string[] = [];
    let visible = Infinity;
    let previousScroll: number | undefined;
    let settledFrames = 0;
    const maximumFrames = 120;
    const minimumFrames = 12;
    for (let frame = 0; frame < maximumFrames; frame++) {
      await new Promise(requestAnimationFrame);
      const paragraph = document.querySelector<HTMLElement>('.caption-page');
      if (!paragraph) throw new Error('Captions must exist');
      const scroll = paragraph.scrollTop;
      settledFrames = scroll === previousScroll ? settledFrames + 1 : 0;
      previousScroll = scroll;
      const bounds = paragraph.getBoundingClientRect();
      const scale = bounds.width / Number.parseFloat(getComputedStyle(paragraph).width);
      const insets = getComputedStyle(paragraph)
        .clipPath.match(/-?[\d.]+px/gu)
        ?.map(Number.parseFloat) ?? [0, 0, 0, 0];
      const top = bounds.top + insets[0] * scale;
      const bottom = bounds.bottom - (insets[2] ?? insets[0]) * scale;
      let frameVisible = 0;
      for (const word of paragraph.querySelectorAll<HTMLElement>('.caption-word')) {
        if (
          getComputedStyle(word).opacity === '0' ||
          getComputedStyle(word).visibility === 'hidden'
        )
          continue;
        const range = document.createRange();
        if (!word.firstElementChild) throw new Error('Caption word must contain text');
        range.selectNodeContents(word.firstElementChild);
        const rect = range.getBoundingClientRect();
        if (rect.bottom <= top || rect.top >= bottom) continue;
        const revealEdge = Number.parseFloat(word.style.getPropertyValue('--reveal-edge'));
        if (
          getComputedStyle(word).maskImage !== 'none' &&
          word.getBoundingClientRect().left + revealEdge <= rect.left
        )
          continue;
        frameVisible++;
        if (rect.top < top || rect.bottom > bottom)
          violations.push(`${word.textContent}: ${rect.top - top}, ${bottom - rect.bottom}`);
      }
      visible = Math.min(visible, frameVisible);
      if (frame >= minimumFrames && settledFrames >= 2) break;
    }
    return { violations, visible };
  });
}

// Like the playback atlas contract, run explicitly without changing the unit-test timeout.
const output = await realpath(await mkdtemp(path.join(tmpdir(), 'nous-caption-rows-')));
const started = performance.now();
try {
  const config = viteConfig({ command: 'build', mode: 'test' });
  await build({
    ...config,
    configFile: false,
    root: path.resolve('apps/web'),
    logLevel: 'error',
    build: {
      outDir: output,
      rollupOptions: { input: path.resolve('apps/web/tests/fixtures/captionRows.html') },
    },
  });
  const server = await preview({
    configFile: false,
    root: path.resolve('apps/web'),
    build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  const baseUrl = server.resolvedUrls?.local[0];
  assert(baseUrl, 'Caption fixture server must expose a local URL');
  try {
    const browsers = process.env.CAPTION_TEST_BROWSER
      ? [process.env.CAPTION_TEST_BROWSER]
      : ['chromium', 'firefox'];
    for (const browserName of browsers) {
      assert(['chromium', 'firefox'].includes(browserName));
      const browser = await (browserName === 'firefox' ? firefox : chromium).launch(
        withMutedAudio({ headless: true })
      );
      const smoke = process.argv.includes('--smoke');
      let cases = 0;
      try {
        for (const height of smoke ? [900] : [700, 900]) {
          for (const width of smoke ? [1440] : [900, 1440]) {
            for (const zoom of smoke ? [1] : [0.9, 1, 1.25]) {
              for (const reducedMotion of smoke
                ? (['no-preference'] as const)
                : (['no-preference', 'reduce'] as const)) {
                const page = await browser.newPage({
                  viewport: { width: Math.round(width / zoom), height: Math.round(height / zoom) },
                  deviceScaleFactor: zoom,
                  reducedMotion,
                });
                const label = `${browserName} ${width}x${height} viewport/DPR zoom=${zoom} motion=${reducedMotion}`;
                try {
                  let releaseFont!: () => void;
                  const fontReady = new Promise<void>(resolve => {
                    releaseFont = resolve;
                  });
                  await page.route('**/*.woff2', async route => {
                    await fontReady;
                    await route.continue();
                  });
                  await page.goto(`${baseUrl}tests/fixtures/captionRows.html`, {
                    waitUntil: 'domcontentloaded',
                  });
                  await page.locator('.caption-word').first().waitFor();
                  const seek = page.getByRole('spinbutton', { name: 'Playback time' });
                  for (const time of [0, 18, 38, 8, 55]) {
                    await seek.fill(String(time));
                    const result = await visibleCaptionRows(page);
                    assert.deepEqual(result.violations, [], `${label} time=${time}`);
                    if (time > 0)
                      assert(
                        result.visible > 0,
                        `${label} time=${time}: revealed rows must be visible`
                      );
                  }
                  releaseFont();
                  await page.evaluate(() => document.fonts.ready);
                  const loadedFont = await visibleCaptionRows(page);
                  assert.deepEqual(loadedFont.violations, [], `${label} late font`);
                  assert(loadedFont.visible > 0, `${label} late font must retain revealed text`);
                  if (reducedMotion === 'no-preference') {
                    await page.evaluate(() => {
                      for (const word of document.querySelectorAll<HTMLElement>('.caption-word')) {
                        word.style.setProperty('--reveal-edge', '-1px');
                      }
                    });
                    assert.equal(
                      (await visibleCaptionRows(page)).visible,
                      0,
                      'Masked text must not count as revealed'
                    );
                  }
                  await seek.fill('54');
                  await page.setViewportSize({ width: width - 57, height: height - 31 });
                  assert.deepEqual(
                    (await visibleCaptionRows(page)).violations,
                    [],
                    `${label} resize`
                  );
                  await page.evaluate(() => {
                    document.documentElement.style.zoom = '1.1';
                    window.dispatchEvent(new Event('resize'));
                  });
                  assert.deepEqual(
                    (await visibleCaptionRows(page)).violations,
                    [],
                    `${label} live zoom`
                  );
                  await page.getByRole('button', { name: 'Next passage' }).click();
                  assert.deepEqual(
                    (await visibleCaptionRows(page)).violations,
                    [],
                    `${label} paragraph reset`
                  );
                  assert.equal(
                    await page.locator('.caption-page').evaluate(element => element.scrollTop),
                    0
                  );
                  await page.getByRole('button', { name: 'Previous passage midpoint' }).click();
                  const atSeek = await page.evaluate(async () => {
                    await new Promise(requestAnimationFrame);
                    const paragraph = document.querySelector<HTMLElement>('.caption-page');
                    if (!paragraph) throw new Error('Captions must exist');
                    const box = paragraph.getBoundingClientRect();
                    const active = Array.from(
                      paragraph.querySelectorAll<HTMLElement>('.caption-word')
                    ).find(word => {
                      const edge = Number.parseFloat(word.style.getPropertyValue('--reveal-edge'));
                      return edge >= 0 && edge <= word.getBoundingClientRect().width;
                    });
                    if (!active) throw new Error('Seek must reveal an active caption word');
                    const text = active.firstElementChild;
                    if (!text) throw new Error('Caption word must contain text');
                    const range = document.createRange();
                    range.selectNodeContents(text);
                    const word = range.getBoundingClientRect();
                    return word.top >= box.top && word.bottom <= box.bottom;
                  });
                  assert(
                    atSeek,
                    `${label}: cross-passage seek must place the active row immediately`
                  );
                  assert.deepEqual(
                    (await visibleCaptionRows(page)).violations,
                    [],
                    `${label} cross-passage seek`
                  );
                  const pausedGeometryReads = await page.evaluate(async () => {
                    const paragraph = document.querySelector<HTMLElement>('.caption-page');
                    if (!paragraph) throw new Error('Captions must exist');
                    const firstWord = paragraph.querySelector<HTMLElement>('.caption-word');
                    if (!firstWord) throw new Error('Caption words must exist');
                    const elements = [paragraph, firstWord];
                    let reads = 0;
                    for (const element of elements) {
                      element.getBoundingClientRect = () => {
                        reads++;
                        return HTMLElement.prototype.getBoundingClientRect.call(element);
                      };
                    }
                    try {
                      const pausedFrames = 12;
                      for (let frame = 0; frame < pausedFrames; frame++)
                        await new Promise(requestAnimationFrame);
                      return reads;
                    } finally {
                      for (const element of elements)
                        Reflect.deleteProperty(element, 'getBoundingClientRect');
                    }
                  });
                  assert.equal(
                    pausedGeometryReads,
                    0,
                    `${label}: paused captions must not reread geometry`
                  );
                  await page.setViewportSize({ width: 390, height: 844 });
                  assert.equal(
                    await page
                      .locator('.captions')
                      .evaluate(element => getComputedStyle(element).visibility),
                    'hidden'
                  );
                  cases++;
                  console.log(`PASS ${label}`);
                } finally {
                  await page.close();
                }
              }
            }
          }
        }
        console.log(
          JSON.stringify({ browser: browserName, cases, durationMs: performance.now() - started })
        );
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
} finally {
  assert.equal(path.dirname(output), await realpath(tmpdir()));
  await rm(output, { recursive: true });
}
