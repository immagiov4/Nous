import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

test.each(['en-US', 'it-IT'])('finds the unavailable image in browser locale %s', async locale => {
  const page = await browser.newPage({ locale });
  try {
    await page.route('**/api/projects/image-geometry/assets/*', route =>
      route.fulfill({ status: 503, body: 'Unavailable' })
    );
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/imageGeometry.html?surface=dialog`
    );
    await page.locator('[role="img"]').waitFor();
    expect(await page.locator('[role="img"]').count()).toBe(1);
  } finally {
    await page.close();
  }
});

const asynchronousCases = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
].flatMap(viewport =>
  [false, true].flatMap(dark =>
    (['reduce', 'no-preference'] as const).map(reducedMotion => ({ viewport, dark, reducedMotion }))
  )
);

test('keeps captions below a studio that replaces an image and fills fullscreen after resizing', async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    const image = await readFile('apps/web/public/icons/nous-app-icon-mask-512.png');
    await page.route('**/api/projects/image-geometry/assets/*', route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: image })
    );
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/imageGeometry.html?surface=playback`
    );
    const figure = page.locator('.scene-host:not([data-exiting]) img[src]');
    await figure.evaluate((node: HTMLImageElement) => node.decode());
    await page.evaluate(() => window.imageGeometryControl('replace-studio'));
    const studio = page.locator('[data-studio="function-plot"] svg.chart');
    await studio.waitFor();
    const slot = page.locator('.scene-fit');
    const captions = page.locator('.listening-stage > .captions');
    await expect
      .poll(async () => {
        const [drawing, text] = await Promise.all([slot.boundingBox(), captions.boundingBox()]);
        if (!drawing || !text) throw new Error('Expected the studio slot and captions');
        return text.y - (drawing.y + drawing.height);
      })
      .toBeGreaterThanOrEqual(0);

    const phone = { width: 390, height: 844 };
    await page.setViewportSize(phone);
    await slot.getByRole('button', { name: /^(Schermo intero|Fullscreen|Full screen)$/i }).click();
    await expect.poll(async () => (await slot.boundingBox())?.height).toBe(phone.height);
    await page.evaluate(() => window.imageGeometryControl('reset'));
    await figure.waitFor();
  } finally {
    await page.close();
  }
});

test.each(
  asynchronousCases
)('keeps the mixed Mermaid frame stable at $viewport.width (dark=$dark, motion=$reducedMotion)', async ({
  viewport,
  dark,
  reducedMotion,
}) => {
  const page = await browser.newPage({ viewport, reducedMotion });
  let release = () => {};
  try {
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let intercepted = false;
    await page.route('**/*flowDiagram*.js', async route => {
      intercepted = true;
      await held;
      await route.continue();
    });
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/imageGeometry.html?surface=playback&scenario=mermaid-math${dark ? '&dark' : ''}`,
      { waitUntil: 'domcontentloaded' }
    );
    await page.locator('.scene-host output[aria-busy="true"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => intercepted).toBe(true);
    await page.waitForTimeout(250);
    const before = await page.locator('.scene-host').boundingBox();
    await page.evaluate(() => {
      Object.assign(window, { mermaidLayoutShifts: [] });
      new PerformanceObserver(list =>
        (window as unknown as { mermaidLayoutShifts: number[] }).mermaidLayoutShifts.push(
          ...list.getEntries().map(entry => (entry as PerformanceEntry & { value: number }).value)
        )
      ).observe({ type: 'layout-shift' });
    });
    release();
    await page.frameLocator('iframe').locator('svg').waitFor();
    await page.waitForTimeout(250);
    const after = await page.locator('.scene-host').boundingBox();
    const shifts = await page.evaluate(
      () => (window as unknown as { mermaidLayoutShifts: number[] }).mermaidLayoutShifts
    );
    if (process.env.NOUS_E2E_DATA) {
      await mkdir(process.env.NOUS_E2E_DATA, { recursive: true });
      await writeFile(
        path.join(
          process.env.NOUS_E2E_DATA,
          `mermaid-${viewport.width}-${dark}-${reducedMotion}.json`
        ),
        JSON.stringify({ before, after, shifts })
      );
    }
    expect(after).toEqual(before);
    expect(shifts.reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(
      await page.locator('.scene-host').evaluate(element => getComputedStyle(element).opacity)
    ).toBe('1');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await page.close();
  }
});

test.each(
  asynchronousCases
)('waits for decoded image presentation in atlas at $viewport.width (dark=$dark, motion=$reducedMotion)', async ({
  viewport,
  dark,
  reducedMotion,
}) => {
  const page = await browser.newPage({ viewport, reducedMotion });
  try {
    await page.addInitScript(() => {
      const original = HTMLImageElement.prototype.decode;
      const releases: (() => void)[] = [];
      Object.assign(window, { imageDecodeReleases: releases });
      HTMLImageElement.prototype.decode = function () {
        const source = this.src;
        return original
          .call(this)
          .then(() =>
            source.startsWith('blob:')
              ? new Promise<void>(resolve => releases.push(resolve))
              : undefined
          );
      };
    });
    const bytes = await readFile('apps/web/public/icons/nous-app-icon-mask-512.png');
    await page.route('**/api/projects/image-geometry/assets/*', route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: bytes })
    );
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/imageGeometry.html?surface=playback${dark ? '&dark' : ''}`
    );
    await page.waitForFunction(
      () =>
        (window as unknown as { imageDecodeReleases: (() => void)[] }).imageDecodeReleases
          .length === 1
    );
    expect(await page.evaluate(() => window.imageGeometryReady())).toBe(false);
    await page.evaluate(() => {
      for (const release of (window as unknown as { imageDecodeReleases: (() => void)[] })
        .imageDecodeReleases)
        release();
    });
    await expect.poll(() => page.evaluate(() => window.imageGeometryReady())).toBe(true);
    expect(
      await page.locator('img[src]').evaluate(element => getComputedStyle(element).opacity)
    ).toBe('1');
  } finally {
    await page.close();
  }
});

test.each(
  ['scene', 'html', 'mermaid', 'pending', 'pending-failure', 'error-dialog'].flatMap(scenario =>
    [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ].flatMap(viewport => [false, true].map(dark => ({ scenario, viewport, dark })))
  )
)('shows available $scenario content at $viewport.width px (dark=$dark)', async ({
  scenario,
  viewport,
  dark,
}) => {
  const page = await browser.newPage({ viewport, reducedMotion: 'no-preference' });
  let release = () => {};
  try {
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    await page.route(
      scenario.startsWith('pending')
        ? '**/lifecycle-image.png'
        : '**/api/projects/image-geometry/assets/*',
      async route => {
        await held;
        await route.fulfill({
          status: scenario === 'error-dialog' || scenario === 'pending-failure' ? 503 : 200,
          contentType: 'image/png',
          body:
            scenario === 'error-dialog' || scenario === 'pending-failure'
              ? Buffer.from('Unavailable')
              : await readFile('apps/web/public/icons/nous-app-icon-mask-512.png'),
        });
      }
    );
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/imageGeometry.html?surface=${scenario === 'error-dialog' ? 'dialog' : 'playback'}&scenario=${scenario.startsWith('pending') ? 'legacy-content' : scenario}${dark ? '&dark' : ''}`
    );
    const card = page.locator('.scene-host');
    const image = page.locator('img').first();
    if (scenario !== 'error-dialog') {
      await card.waitFor({ state: 'attached' });
      await page.waitForTimeout(250);
      expect(await card.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
      expect((await card.boundingBox())?.height).toBeGreaterThan(0);
      if (scenario === 'html') {
        const html = page.frameLocator('iframe').getByText('Visible HTML visual');
        await html.waitFor();
        expect(await html.isVisible()).toBe(true);
      } else if (scenario === 'mermaid') {
        const diagram = page.frameLocator('iframe').locator('svg');
        await diagram.waitFor();
        expect(await diagram.isVisible()).toBe(true);
      } else expect(await card.locator('.katex, .lesson-scene').count()).toBeGreaterThan(0);
    }
    if (scenario.startsWith('pending') || scenario === 'error-dialog') {
      const before = await image.boundingBox();
      expect(before?.height).toBeGreaterThan(0);
      release();
      if (scenario === 'error-dialog' || scenario === 'pending-failure') {
        const fallback = page.locator('[role="img"]');
        await fallback.waitFor();
        const after = await fallback.boundingBox();
        expect(after).toEqual(before);
      } else {
        await image.evaluate((element: HTMLImageElement) => element.decode());
        await page.waitForTimeout(250);
        expect(await image.boundingBox()).toEqual(before);
        expect(await image.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
      }
    }
    if (scenario !== 'error-dialog' && viewport.width === 390)
      expect(
        await page.locator('.captions').evaluate(element => getComputedStyle(element).visibility)
      ).toBe('hidden');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await page.close();
  }
});

test.each(
  ['replace', 'replace-steps', 'replace-causal', 'replace-html', 'replace-mermaid'].flatMap(
    action =>
      [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ].flatMap(viewport =>
        [false, true].map(dark => ({
          action: action as
            | 'replace'
            | 'replace-steps'
            | 'replace-causal'
            | 'replace-html'
            | 'replace-mermaid',
          viewport,
          dark,
        }))
      )
  )
)('keeps the incoming $action visual painted after image exit at $viewport.width (dark=$dark)', async ({
  action,
  viewport,
  dark,
}) => {
  const page = await browser.newPage({ viewport, reducedMotion: 'no-preference' });
  try {
    const bytes = await readFile('apps/web/public/icons/nous-app-icon-mask-512.png');
    await page.route('**/api/projects/image-geometry/assets/*', route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: bytes })
    );
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/imageGeometry.html?surface=playback${dark ? '&dark' : ''}`
    );
    await page
      .locator('.scene-host img[src]')
      .evaluate((image: HTMLImageElement) => image.decode());
    await page.waitForTimeout(250);
    await page.evaluate(action => window.imageGeometryControl(action), action);
    if (action === 'replace-html')
      await page.frameLocator('iframe').getByText('Visible HTML visual').waitFor();
    else if (action === 'replace-mermaid')
      await page.frameLocator('iframe').locator('svg').waitFor();
    await page.waitForTimeout(250);
    expect(await page.locator('.scene-host[data-exiting]').count()).toBe(0);
    const settled = await page.locator('.scene-host').evaluate(async card => {
      const frames = [];
      for (let index = 0; index < 30; index++) {
        await new Promise(requestAnimationFrame);
        frames.push({
          opacity: Number(getComputedStyle(card).opacity),
          height: card.getBoundingClientRect().height,
        });
      }
      return frames;
    });
    expect(settled.every(frame => frame.opacity === 1 && frame.height > 0)).toBe(true);
    if (['replace', 'replace-steps', 'replace-causal'].includes(action))
      expect(await page.locator('.scene-host').textContent()).toContain('Replacement visual');
  } finally {
    await page.close();
  }
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
          await expect.poll(() => page.evaluate(() => window.imageGeometryReady())).toBe(true);
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

interface LifecycleBox {
  id: number;
  x: number;
  y: number;
  opacity: number;
  inside: boolean;
  width: number;
  height: number;
  decoded: boolean;
}
interface LifecycleFrame {
  cards: LifecycleBox[];
  images: LifecycleBox[];
}

async function lifecycleFrames(page: import('playwright').Page): Promise<LifecycleFrame[]> {
  return page.evaluate(async () => {
    const identities = new WeakMap<Element, number>();
    let ordinal = 0;
    const result: LifecycleFrame[] = [];
    const box = (element: Element): LifecycleBox => {
      if (!identities.has(element)) identities.set(element, ++ordinal);
      const bounds = element.getBoundingClientRect();
      const slot = element.closest('.scene-fit')?.getBoundingClientRect();
      let opacity = 1;
      for (let parent: Element | null = element; parent; parent = parent.parentElement)
        opacity *= Number(getComputedStyle(parent).opacity);
      return {
        id: identities.get(element) as number,
        x: bounds.x,
        y: bounds.y,
        opacity,
        inside:
          !!slot &&
          Math.round(bounds.left) >= Math.round(slot.left) &&
          Math.round(bounds.right) <= Math.round(slot.right) &&
          Math.round(bounds.top) >= Math.round(slot.top) &&
          Math.round(bounds.bottom) <= Math.round(slot.bottom),
        width: bounds.width,
        height: bounds.height,
        decoded:
          !(element instanceof HTMLImageElement) || (element.complete && element.naturalWidth > 0),
      };
    };
    for (let frame = 0; frame < 100; frame++) {
      await new Promise(requestAnimationFrame);
      result.push({
        cards: Array.from(document.querySelectorAll('.scene-host'), box),
        images: Array.from(document.querySelectorAll('.scene-host img[src]'), box),
      });
    }
    return result;
  });
}

const lifecycleCases = ['failure', 'cached', 'legacy', 'replacement'].flatMap(scenario =>
  [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ].flatMap(viewport => [false, true].map(dark => ({ scenario, viewport, dark })))
);
test.each(
  lifecycleCases
)('keeps $scenario paints fitted and smooth at $viewport.width px (dark=$dark)', async ({
  scenario,
  viewport,
  dark,
}) => {
  const bytes = await readFile('apps/web/public/icons/nous-app-icon-mask-512.png');
  const page = await browser.newPage({ viewport, reducedMotion: 'no-preference' });
  const releases: (() => void)[] = [];
  try {
    await page.addInitScript(() => {
      Object.assign(window, { imageLifecycleShifts: [] });
      new PerformanceObserver(list => {
        const shifts = (window as unknown as { imageLifecycleShifts: number[] })
          .imageLifecycleShifts;
        shifts.push(
          ...list.getEntries().map(entry => (entry as PerformanceEntry & { value: number }).value)
        );
      }).observe({ type: 'layout-shift', buffered: true });
    });
    const requested: string[] = [];
    await page.route(
      scenario === 'legacy' ? '**/lifecycle-image.png' : '**/api/projects/image-geometry/assets/*',
      async route => {
        requested.push(route.request().url());
        if ((scenario === 'failure' && requested.length <= 3) || scenario === 'legacy')
          await new Promise<void>(resolve => releases.push(resolve));
        const failed = scenario === 'failure' && route.request().url().endsWith('b'.repeat(64));
        await route.fulfill({
          status: failed ? 503 : 200,
          contentType: 'image/png',
          body: failed ? Buffer.from('Unavailable') : bytes,
        });
      }
    );
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/imageGeometry.html?surface=playback&scenario=${scenario === 'failure' ? 'multi' : scenario === 'legacy' ? 'legacy' : ''}${dark ? '&dark' : ''}`
    );
    await page.waitForFunction(() => typeof window.imageGeometryControl === 'function');
    if (scenario === 'cached' || scenario === 'replacement') {
      await page.locator('img[src^="blob:"]').evaluate((image: HTMLImageElement) => image.decode());
      await page.evaluate(async () => {
        await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
      });
    } else {
      await expect.poll(() => requested.length).toBe(scenario === 'failure' ? 3 : 1);
    }
    if (scenario === 'cached') {
      await page.evaluate(() => window.imageGeometryControl('hide'));
      await page.locator('.scene-host').waitFor({ state: 'detached' });
      const cpu = await page.context().newCDPSession(page);
      await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await page.evaluate(() => {
      (window as unknown as { imageLifecycleShifts: number[] }).imageLifecycleShifts.length = 0;
    });
    const recording = lifecycleFrames(page);
    if (scenario === 'cached') await page.evaluate(() => window.imageGeometryControl('show'));
    else if (scenario === 'replacement')
      await page.evaluate(() => window.imageGeometryControl('replace'));
    else if (scenario === 'failure') {
      releases[0]();
      await page
        .locator('img[src^="blob:"]')
        .first()
        .evaluate((image: HTMLImageElement) => image.decode());
      releases[1]();
      releases[2]();
    } else releases[0]();
    const frames = await recording;
    const shifts = await page.evaluate(
      () => (window as unknown as { imageLifecycleShifts: number[] }).imageLifecycleShifts
    );
    if (process.env.NOUS_E2E_DATA) {
      await mkdir(process.env.NOUS_E2E_DATA, { recursive: true });
      await writeFile(
        path.join(process.env.NOUS_E2E_DATA, `${scenario}-${viewport.width}-${dark}.json`),
        JSON.stringify({ frames, shifts })
      );
    }
    const visibleCards = frames.flatMap(frame => frame.cards).filter(box => box.opacity > 0);
    const visibleImages = frames.flatMap(frame => frame.images).filter(box => box.opacity > 0);
    expect(visibleCards.length).toBeGreaterThan(0);
    expect(visibleImages.length).toBeGreaterThan(0);
    expect(visibleCards.every(box => box.inside)).toBe(true);
    expect(visibleImages.every(box => box.inside && box.decoded)).toBe(true);
    expect(shifts.reduce((sum, shift) => sum + shift, 0)).toBe(0);
    if (scenario === 'cached') expect(visibleImages.some(box => box.opacity < 1)).toBe(true);
    if (scenario === 'replacement') {
      expect(visibleCards.some(box => box.opacity < 1)).toBe(true);
      expect(frames.at(-1)?.cards.some(card => card.opacity === 1)).toBe(true);
      expect(await page.locator('.scene-host:not([data-exiting])').textContent()).toContain(
        'Replacement visual'
      );
    }
    if (scenario === 'failure') {
      for (const id of new Set(visibleImages.map(image => image.id))) {
        const boxes = visibleImages.filter(image => image.id === id);
        expect(
          new Set(boxes.map(box => [box.x, box.y, box.width, box.height].map(Math.round).join(',')))
            .size
        ).toBe(1);
      }
      expect(await page.locator('.scene-host img[src]').count()).toBe(2);
      expect(await page.locator('.scene-host img:not([src])').count()).toBe(1);
      expect(await page.locator('[role="img"]').count()).toBe(1);
    }
    if (viewport.width === 390)
      expect(await page.locator('.captions').evaluate(e => getComputedStyle(e).visibility)).toBe(
        'hidden'
      );
  } finally {
    for (const release of releases) release();
    await page.unrouteAll({ behavior: 'wait' });
    await page.close();
  }
});
