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
        if (!word.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
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

async function activeCaptionIsVisible(page: Page) {
  return page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const paragraph = document.querySelector<HTMLElement>('.caption-page');
    if (!paragraph) throw new Error('Captions must exist');
    const box = paragraph.getBoundingClientRect();
    const active = paragraph.querySelector<HTMLElement>('.caption-word[aria-current="true"]');
    if (!active?.firstElementChild) throw new Error('Playback must reveal an active caption word');
    const range = document.createRange();
    range.selectNodeContents(active.firstElementChild);
    const word = range.getBoundingClientRect();
    return word.top >= box.top && word.bottom <= box.bottom;
  });
}

async function mobilePlaybackShowsOnlyVisuals(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}tests/fixtures/captionRows.html?mobile`);
  const caption = page.locator('.caption-word').first();
  const visual = page.getByRole('heading', { name: 'Memoria e processore' });
  await page.getByRole('spinbutton', { name: 'Playback time' }).fill('18');
  for (const width of [390, 650, 651]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert(await visual.isVisible(), `width=${width}: lesson visual remains visible`);
    const stage = page.locator('.lesson-player-stage');
    const visibleText = await stage.innerText();
    const accessibleText = await stage.ariaSnapshot();
    const desktop = width > 650;
    assert.equal(await caption.isVisible(), desktop, `width=${width}: caption visibility`);
    if (desktop)
      assert((await visibleCaptionRows(page)).visible > 0, `width=${width}: painted caption text`);
    assert.equal(visibleText.includes('conserva'), desktop, `width=${width}: visible caption text`);
    assert.equal(
      accessibleText.includes('conserva'),
      desktop,
      `width=${width}: accessible caption text`
    );
  }
}

async function spokenRowSurvivesThemeRemeasurement(page: Page, baseUrl: string) {
  await page.setViewportSize({ width: 651, height: 500 });
  await page.goto(`${baseUrl}tests/fixtures/captionRows.html?follow`);
  await page.getByRole('spinbutton', { name: 'Playback time' }).fill('6.2');
  const advance = (time: number) =>
    page.evaluate(
      time => dispatchEvent(new CustomEvent('caption-playback-time', { detail: time })),
      time
    );
  const spokenVisible = (index: number) =>
    page.evaluate(async index => {
      await new Promise(requestAnimationFrame);
      const paragraph = document.querySelector<HTMLElement>('.caption-page');
      if (!paragraph) throw new Error('Captions must exist');
      const word = paragraph.querySelectorAll('.caption-word')[index]?.firstElementChild;
      if (!word) throw new Error('Spoken word must exist');
      const bounds = paragraph.getBoundingClientRect();
      const scale = bounds.width / Number.parseFloat(getComputedStyle(paragraph).width);
      const insets = getComputedStyle(paragraph)
        .clipPath.match(/-?[\d.]+px/gu)
        ?.map(Number.parseFloat) ?? [0, 0, 0, 0];
      const glyph = document.createRange();
      glyph.selectNodeContents(word);
      const box = glyph.getBoundingClientRect();
      return (
        box.top >= bounds.top + insets[0] * scale &&
        box.bottom <= bounds.bottom - (insets[2] ?? insets[0]) * scale
      );
    }, index);
  await advance(6.95);
  await visibleCaptionRows(page);
  assert(
    await spokenVisible(27),
    'Auto-follow keeps the acoustic word visible despite leading fill'
  );
  await advance(11.95);
  await visibleCaptionRows(page);
  for (const dark of [true, false]) {
    await page.getByRole('button', { name: 'Switch theme' }).click();
    await page.evaluate(() => dispatchEvent(new Event('resize')));
    assert(
      await spokenVisible(47),
      `Theme ${dark ? 'dark' : 'light'} remeasurement keeps the spoken word visible`
    );
  }
  await advance(15.95);
  await visibleCaptionRows(page);
  assert(await spokenVisible(63), 'Theme remeasurement does not disable automatic following');
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function captionScrollbarsStayHidden(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}tests/fixtures/captionRows.html`);
  for (const theme of ['light', 'dark']) {
    const scrollbar = await page.locator('.caption-page').evaluate(element => ({
      width: getComputedStyle(element).scrollbarWidth,
      gutter: (element as HTMLElement).offsetWidth - element.clientWidth,
      overflow: element.scrollHeight > element.clientHeight,
      webkit: CSS.supports('selector(::-webkit-scrollbar)')
        ? getComputedStyle(element, '::-webkit-scrollbar').display
        : undefined,
    }));
    assert(scrollbar.overflow, `${theme}: the long paragraph remains scrollable`);
    assert.equal(scrollbar.width, 'none', `${theme}: no native caption scrollbar`);
    assert.equal(scrollbar.gutter, 0, `${theme}: no visible caption scrollbar gutter`);
    if (scrollbar.webkit !== undefined)
      assert.equal(scrollbar.webkit, 'none', `${theme}: no WebKit caption scrollbar`);
    await page.getByRole('button', { name: 'Switch theme' }).click();
  }
}

async function paragraphFillSurvivesThemesAndManualReading(
  page: Page,
  baseUrl: string,
  input: 'wheel' | 'keyboard'
) {
  console.log(`Checking manual caption input: ${input}`);
  await page.goto(`${baseUrl}tests/fixtures/captionRows.html`);
  await page.getByRole('spinbutton', { name: 'Playback time' }).fill('18');
  const read = () =>
    page.locator('.caption-page').evaluate(async paragraph => {
      await Promise.all(
        paragraph.getAnimations({ subtree: true }).map(animation => animation.finished)
      );
      const words = Array.from(paragraph.querySelectorAll<HTMLElement>('.caption-word'));
      return {
        opacity: words.map(word => Number(getComputedStyle(word).opacity)),
        color: getComputedStyle(words[0]).color,
      };
    });
  const light = await read();
  assert.equal(light.opacity[0], 1, 'Spoken words retain full colour');
  assert.equal(light.opacity.at(-1), 0.5, 'Future words remain readable');
  for (const dark of [true, false]) {
    await page.getByRole('button', { name: 'Switch theme' }).click();
    const after = await read();
    assert.deepEqual(after.opacity, light.opacity, 'Theme changes preserve every word fill');
    assert.equal(after.color === light.color, !dark, 'Word colour follows the current theme');
  }
  const paragraph = page.locator('.caption-page');
  await visibleCaptionRows(page);
  if (input === 'wheel') {
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent('caption-playback-time', { detail: 38 }))
    );
    const box = await paragraph.boundingBox();
    assert(box);
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await visibleCaptionRows(page);
    await page.mouse.up();
    const afterPress = await paragraph.evaluate(element => element.scrollTop);
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent('caption-playback-time', { detail: 55 }))
    );
    await page.waitForFunction(
      before => (document.querySelector('.caption-page')?.scrollTop ?? 0) > before,
      afterPress
    );
    await page.getByRole('spinbutton', { name: 'Playback time' }).fill('18');
    await visibleCaptionRows(page);
  }
  const followingPosition = await paragraph.evaluate(element => element.scrollTop);
  if (input === 'keyboard') {
    await paragraph.focus();
    assert(
      await paragraph.evaluate(element => element === document.activeElement),
      'Caption region is focusable'
    );
    await page.keyboard.press('PageDown');
  } else {
    await paragraph.hover();
    await page.mouse.wheel(0, 250);
  }
  await page.waitForFunction(before => {
    const paragraph = document.querySelector('.caption-page');
    return paragraph && paragraph.scrollTop !== before;
  }, followingPosition);
  assert.deepEqual((await visibleCaptionRows(page)).violations, []);
  const manual = await paragraph.evaluate(element => element.scrollTop);
  await page.getByRole('spinbutton', { name: 'Playback time' }).fill('8');
  await read();
  assert.equal(await paragraph.evaluate(element => element.scrollTop), manual);
  await page.getByRole('button', { name: 'Next passage', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Playback time' }).fill('38');
  await read();
  await page.waitForFunction(() => (document.querySelector('.caption-page')?.scrollTop ?? 0) > 0);
  assert(
    (await paragraph.evaluate(element => element.scrollTop)) > 0,
    'Next paragraph resumes following'
  );
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
      // Expose native controls so scrollbar absence is a product-style assertion.
      const browser = await (browserName === 'firefox' ? firefox : chromium).launch(
        withMutedAudio({
          headless: true,
          ignoreDefaultArgs: ['--hide-scrollbars'],
        })
      );
      const smoke = process.argv.includes('--smoke');
      let cases = 0;
      try {
        const mobilePage = await browser.newPage();
        try {
          await mobilePlaybackShowsOnlyVisuals(mobilePage, baseUrl);
          console.log(`PASS ${browserName}: mobile visuals only; desktop captions retained`);
        } finally {
          await mobilePage.close();
        }
        if (process.argv.includes('--mobile-only')) continue;
        const paragraphPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        try {
          await captionScrollbarsStayHidden(paragraphPage, baseUrl);
          await spokenRowSurvivesThemeRemeasurement(paragraphPage, baseUrl);
          for (const input of ['wheel', 'keyboard'] as const)
            await paragraphFillSurvivesThemesAndManualReading(paragraphPage, baseUrl, input);
          console.log(`PASS ${browserName}: paragraph fill, both themes and manual reading`);
        } finally {
          await paragraphPage.close();
        }
        if (process.argv.includes('--paragraph-fill')) continue;
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
                  const atSeek = await activeCaptionIsVisible(page);
                  assert(
                    atSeek,
                    `${label}: cross-passage seek must place the active row immediately`
                  );
                  assert.deepEqual(
                    (await visibleCaptionRows(page)).violations,
                    [],
                    `${label} cross-passage seek`
                  );
                  const beforeTimingScroll = await page
                    .locator('.caption-page')
                    .evaluate(element => element.scrollTop);
                  assert(
                    beforeTimingScroll > 0,
                    `${label}: timing adoption must exercise a scrolled viewport`
                  );
                  for (const phase of ['arrival', 'equivalent refresh']) {
                    await page.getByRole('button', { name: 'Refresh recording timing' }).click();
                    assert.equal(
                      await page.locator('.caption-page').evaluate(element => element.scrollTop),
                      beforeTimingScroll,
                      `${label} timing ${phase}: reading position`
                    );
                    assert.deepEqual(
                      (await visibleCaptionRows(page)).violations,
                      [],
                      `${label} timing ${phase}: complete rows`
                    );
                  }
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
                  await page.evaluate(() => {
                    document.documentElement.style.zoom = '1';
                  });
                  await page.setViewportSize({ width: 700, height: 900 });
                  await seek.fill('38');
                  await visibleCaptionRows(page);
                  const narrowScroll = await page
                    .locator('.caption-page')
                    .evaluate(element => element.scrollTop);
                  await page.setViewportSize({ width: 950, height: 900 });
                  assert(
                    await activeCaptionIsVisible(page),
                    `${label}: reflow must retain the active row`
                  );
                  assert(
                    (await page.locator('.caption-page').evaluate(element => element.scrollTop)) <
                      narrowScroll,
                    `${label}: widening must follow the active row upward`
                  );
                  assert.deepEqual(
                    (await visibleCaptionRows(page)).violations,
                    [],
                    `${label} widening`
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
