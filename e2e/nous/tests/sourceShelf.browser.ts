import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { unavailableCourseGenerationApi } from '../../../apps/backend/src/workflows/courseGenerationApi';
import { dataRoot, withMemoryProjectBrowserStack } from '../stack';

// Synthetic files exercise real home attachment actions; artifacts stay outside Git.
// NOUS_E2E_DATA=<external> bun scripts/heavy-run.mjs --label source-shelf -- bun e2e/nous/tests/sourceShelf.browser.ts
const evidence = join(dataRoot(), 'source-shelf');
await mkdir(evidence, { recursive: true });
const sourceTitles = [
  'Probabilità_concetti-di-base',
  'Probabilità_condizionata-e-indipendenza',
  'Il_teorema-di-Bayes',
  'Le_variabili-casuali-introduzione',
  'Le_variabili-casuali-discrete',
  'Esercizi_e-applicazioni',
];
const results: object[] = [];
const errors: string[] = [];
const contrasts: object[] = [];

async function attach(page: Page, count: number, titles = sourceTitles) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-home-chat-target=attachment]').click();
  await (await chooser).setFiles(
    Array.from({ length: count }, (_, index) => ({
      name: `${String(index + 1).padStart(2, '0')}_${titles[index % titles.length]}.md`,
      mimeType: 'text/markdown',
      buffer: Buffer.from(
        `# Source ${index + 1}\nSynthetic probability notes for shelf verification.`
      ),
    }))
  );
  await page.waitForFunction(
    expected => document.querySelectorAll('.source-shelf-item').length === expected,
    count
  );
  await page.getByText('Verifica dei file…', { exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(() => document.fonts.ready);
}

async function clear(page: Page) {
  await page.getByRole('button', { name: 'Rimuovi allegato', exact: true }).click();
  await page.locator('.source-shelf').waitFor({ state: 'detached' });
}

await withMemoryProjectBrowserStack(
  {
    userId: 'source-shelf-user',
    appOptions: {
      courseGenerationApi: { ...unavailableCourseGenerationApi, getActive: async () => null },
    },
  },
  async ({ page, url }) => {
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Impara un nuovo argomento', exact: true }).click();
    const heights = new Map<string, number>();
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      for (const dark of [false, true]) {
        await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
        await page.evaluate(
          enabled => document.documentElement.classList.toggle('dark', enabled),
          dark
        );
        for (const count of [1, 5, 32]) {
          const started = performance.now();
          await attach(page, count);
          const readyMs = performance.now() - started;
          const shelf = page.getByRole('region', { name: 'Le tue fonti', exact: true });
          const books = shelf.locator('.source-shelf-item');
          assert.equal(await books.count(), count);
          assert.equal(
            await books.first().locator('.source-book-title').textContent(),
            'Probabilità concetti di base'
          );
          assert.equal(
            await books.first().getAttribute('aria-label'),
            '01_Probabilità_concetti-di-base.md'
          );
          const label = `${viewport.width}-${dark ? 'dark' : 'light'}-${count}`;
          await page.screenshot({
            path: join(evidence, `${label}.png`),
            fullPage: true,
            animations: 'disabled',
          });
          const geometry = await shelf.evaluate(element => {
            const list = element.querySelector<HTMLElement>('.source-shelf-books');
            assertElement(list);
            return {
              height: element.getBoundingClientRect().height,
              width: list.clientWidth,
              scrollWidth: list.scrollWidth,
              pageWidth: document.documentElement.scrollWidth,
              viewportWidth: innerWidth,
            };
            function assertElement(value: HTMLElement | null): asserts value is HTMLElement {
              if (!value) throw new Error('Missing shelf list');
            }
          });
          assert(geometry.pageWidth <= geometry.viewportWidth, `Page overflow: ${label}`);
          const key = `${viewport.width}-${dark}`;
          if (heights.has(key)) assert.equal(geometry.height, heights.get(key));
          else heights.set(key, geometry.height);
          if (count === 32) {
            assert(geometry.scrollWidth > geometry.width);
            const coverContrasts = await books.evaluateAll(async nodes => {
              const image = await createImageBitmap(
                await (await fetch('/source-shelf/book-neutral.webp')).blob()
              );
              const canvas = document.createElement('canvas');
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext('2d');
              if (!context) throw new Error('Missing cover sample context');
              context.drawImage(image, 0, 0);
              const pixels = context.getImageData(65, 60, 175, 240).data;
              image.close();
              const rgb = (colour: string) =>
                (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
              const luminance = (channels: number[]) =>
                channels.reduce((sum, channel, index) => {
                  const s = channel / 255;
                  return (
                    sum +
                    (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) *
                      [0.2126, 0.7152, 0.0722][index]
                  );
                }, 0);
              return nodes.slice(0, 6).map(node => {
                const tint = node.querySelector('.source-book-tint');
                const cover = node.querySelector('.source-book-cover');
                if (!tint || !cover) throw new Error('Missing book layers');
                const colour = rgb(getComputedStyle(tint).backgroundColor);
                const ink = luminance(rgb(getComputedStyle(cover).color));
                let minimum = Number.POSITIVE_INFINITY;
                for (let i = 0; i < pixels.length; i += 4) {
                  const background = colour.map((channel, c) => (channel * pixels[i + c]) / 255);
                  minimum = Math.min(minimum, (luminance(background) + 0.05) / (ink + 0.05));
                }
                return { palette: node.getAttribute('data-palette'), ratio: minimum };
              });
            });
            assert(
              coverContrasts.every(cover => cover.ratio >= 4.5),
              JSON.stringify(coverContrasts)
            );
            contrasts.push({ label, coverContrasts });
            await books.first().focus();
            await page.keyboard.press('ArrowRight');
            assert(await books.nth(1).evaluate(element => element === document.activeElement));
            await page.keyboard.press('End');
            assert(await books.last().evaluate(element => element === document.activeElement));
            assert(
              await shelf.locator('.source-shelf-books').evaluate(element => element.scrollLeft > 0)
            );
            const last = await books.last().boundingBox();
            assert(last && last.x >= 0 && last.x + last.width <= viewport.width);
            await page.screenshot({
              path: join(evidence, `${label}-keyboard-end.png`),
              fullPage: true,
              animations: 'disabled',
            });
            await page.keyboard.press('Tab');
            assert((await page.locator('.source-shelf-item:focus').count()) === 0);
          }
          results.push({ label, ...geometry, readyMs });
          await clear(page);
        }
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await attach(page, 1, [
      'Probabilità_condizionata_e_indipendenza_degli_eventi_con_applicazioni_alle_variabili_casuali_e_alla_statistica_inferenziale',
    ]);
    await page.screenshot({
      path: join(evidence, 'long-title.png'),
      fullPage: true,
      animations: 'disabled',
    });
    const first = page.locator('.source-shelf-item').first();
    await first.focus();
    await first.hover();
    const motion = await first.evaluate(element => {
      const book = element.querySelector('.source-book');
      if (!book) throw new Error('Missing book');
      return {
        transform: getComputedStyle(book).transform,
        transition: getComputedStyle(book).transitionDuration,
        animation: getComputedStyle(element).animationName,
      };
    });
    assert.deepEqual(motion, { transform: 'none', transition: '0s', animation: 'none' });
    await clear(page);

    // Separate recorded contexts retain the real product, with no foreground browser.
    const browser = page.context().browser();
    assert(browser);
    const videos: object[] = [];
    for (const scene of [
      { name: 'light', width: 1280, height: 800, dark: false },
      { name: 'dark', width: 1280, height: 800, dark: true },
      { name: 'mobile', width: 390, height: 844, dark: false },
    ]) {
      const context = await browser.newContext({
        locale: 'it-IT',
        viewport: { width: scene.width, height: scene.height },
        recordVideo: { dir: evidence, size: { width: scene.width, height: scene.height } },
        colorScheme: scene.dark ? 'dark' : 'light',
      });
      await context.addInitScript(
        config => Object.assign(globalThis, { __NOUS_RUNTIME_CONFIG__: config }),
        { authMode: 'local-bypass', backendUrl: url }
      );
      const recorded = await context.newPage();
      recorded.on('pageerror', error => errors.push(error.message));
      await recorded.goto(url, { waitUntil: 'domcontentloaded' });
      await recorded
        .getByRole('button', { name: 'Impara un nuovo argomento', exact: true })
        .click();
      await recorded.evaluate(
        dark => document.documentElement.classList.toggle('dark', dark),
        scene.dark
      );
      const start = Date.now();
      await recorded.waitForTimeout(450);
      await attach(recorded, 5);
      await recorded.waitForTimeout(650);
      const books = recorded.locator('.source-shelf-item');
      await books.nth(1).hover();
      await recorded.waitForTimeout(700);
      await books.first().focus();
      await recorded.keyboard.press('ArrowRight');
      await recorded.waitForTimeout(700);
      await clear(recorded);
      await attach(recorded, 32);
      await recorded.waitForTimeout(650);
      await recorded.locator('.source-shelf-item').first().focus();
      for (let index = 0; index < 7; index += 1) {
        await recorded.keyboard.press('ArrowRight');
        await recorded.waitForTimeout(200);
      }
      await recorded.keyboard.press('End');
      await recorded.waitForTimeout(800);
      const video = recorded.video();
      assert(video);
      const durationMs = Date.now() - start;
      await context.close();
      const path = join(evidence, `${scene.name}.webm`);
      await video.saveAs(path);
      videos.push({ scene: scene.name, path, durationMs });
    }
    const closeupContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      locale: 'it-IT',
    });
    await closeupContext.addInitScript(
      config => Object.assign(globalThis, { __NOUS_RUNTIME_CONFIG__: config }),
      { authMode: 'local-bypass', backendUrl: url }
    );
    const closeup = await closeupContext.newPage();
    await closeup.goto(url);
    await closeup.getByRole('button', { name: 'Impara un nuovo argomento', exact: true }).click();
    await attach(closeup, 3);
    await closeup
      .locator('.source-shelf')
      .screenshot({ path: join(evidence, 'three-books-2x.png'), animations: 'disabled' });
    await closeupContext.close();
    assert.deepEqual(errors, []);
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        { results, videos, contrasts, reducedMotion: motion, pageErrors: errors },
        null,
        2
      )
    );
  }
);
console.log(
  'Source shelf: 12 scenes, keyboard, reduced motion, 2x close-up and 3 recorded flows passed.'
);
