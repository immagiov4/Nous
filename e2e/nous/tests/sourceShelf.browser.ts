import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unavailableCourseGenerationApi } from '../../../apps/backend/src/workflows/courseGenerationApi';
import { dataRoot, withMemoryProjectBrowserStack } from '../stack';

// Real home upload/remove flow with synthetic files; no provider generation is involved.
// Run: NOUS_E2E_DATA=<external directory> bun scripts/heavy-run.mjs --label source-shelf -- bun e2e/nous/tests/sourceShelf.browser.ts
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

await withMemoryProjectBrowserStack(
  {
    userId: 'source-shelf-user',
    appOptions: {
      courseGenerationApi: { ...unavailableCourseGenerationApi, getActive: async () => null },
    },
  },
  async ({ page, url }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Impara un nuovo argomento', exact: true }).click();
    const heights = new Map<string, number>();
    const contrasts: object[] = [];
    for (const viewport of [
      { width: 1440, height: 1000 },
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
          const files = Array.from({ length: count }, (_, index) => ({
            name: `${String(index + 1).padStart(2, '0')}_${sourceTitles[index % sourceTitles.length]}.md`,
            mimeType: 'text/markdown',
            buffer: Buffer.from(
              `# Source ${index + 1}\nSynthetic probability notes for shelf verification.`
            ),
          }));
          const chooser = page.waitForEvent('filechooser');
          await page.locator('[data-home-chat-target=attachment]').click();
          await (await chooser).setFiles(files);
          const shelf = page.getByRole('region', { name: 'Le tue fonti', exact: true });
          await shelf.waitFor();
          await page.waitForFunction(
            expected => document.querySelectorAll('.source-shelf-item').length === expected,
            count
          );
          await page.getByText('Verifica dei file…', { exact: true }).waitFor({ state: 'hidden' });
          const books = shelf.getByRole('listitem');
          assert.deepEqual(
            await books.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))),
            files.map(file => file.name)
          );
          await page.evaluate(() => document.fonts.ready);
          // Screenshot waits for the appearance transition, then captures the real attachment surface.
          const label = `${viewport.width}-${dark ? 'dark' : 'light'}-${count}`;
          await page.screenshot({
            path: join(evidence, `${label}.png`),
            fullPage: true,
            animations: 'disabled',
          });
          const geometry = await shelf.evaluate(element => {
            const list = element.querySelector('.source-shelf-books');
            assertElement(list);
            return {
              height: element.getBoundingClientRect().height,
              rowHeight: list.clientHeight,
              width: list.clientWidth,
              scrollWidth: list.scrollWidth,
              pageWidth: document.documentElement.scrollWidth,
              viewportWidth: innerWidth,
            };
            function assertElement(value: Element | null): asserts value is HTMLElement {
              if (!(value instanceof HTMLElement)) throw new Error('Missing shelf list');
            }
          });
          assert(geometry.pageWidth <= geometry.viewportWidth, `Page overflow: ${label}`);
          const heightKey = `${viewport.width}-${dark}`;
          if (heights.has(heightKey)) assert.equal(geometry.height, heights.get(heightKey));
          else heights.set(heightKey, geometry.height);
          if (count === 32) {
            assert(geometry.scrollWidth > geometry.width);
            const coverContrasts = await books.evaluateAll(async nodes => {
              const image = await createImageBitmap(
                await (await fetch('/source-shelf/cloth.webp')).blob()
              );
              const canvas = document.createElement('canvas');
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext('2d');
              if (!context) throw new Error('Missing texture sample context');
              context.drawImage(image, 0, 0);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
              let darkest = 255;
              for (let index = 0; index < pixels.length; index += 4)
                darkest = Math.min(darkest, pixels[index], pixels[index + 1], pixels[index + 2]);
              image.close();
              const luminance = (rgb: number[]) =>
                rgb.reduce((sum, channel, index) => {
                  const s = channel / 255;
                  return (
                    sum +
                    (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) *
                      [0.2126, 0.7152, 0.0722][index]
                  );
                }, 0);
              const rgb = (colour: string) =>
                (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
              return nodes.slice(0, 6).map(node => {
                const cover = node.querySelector('.source-book-cover');
                if (!cover) throw new Error('Missing book cover');
                const style = getComputedStyle(cover);
                const opacity = Number(getComputedStyle(cover, '::before').opacity);
                const textured = rgb(style.backgroundColor).map(
                  channel => channel * (1 - opacity + (opacity * darkest) / 255)
                );
                return {
                  palette: node.getAttribute('data-palette'),
                  ratio: (luminance(textured) + 0.05) / (luminance(rgb(style.color)) + 0.05),
                };
              });
            });
            assert(
              coverContrasts.every(cover => cover.ratio >= 4.5),
              JSON.stringify(coverContrasts)
            );
            contrasts.push({ label, coverContrasts });
            await books.first().focus();
            for (let index = 1; index < count; index += 1) await page.keyboard.press('Tab');
            assert(await books.last().evaluate(element => document.activeElement === element));
            assert(
              await shelf
                .locator('ul.source-shelf-books')
                .evaluate(element => element.scrollLeft > 0)
            );
            const finalBook = await books.last().boundingBox();
            assert(
              finalBook && finalBook.x >= 0 && finalBook.x + finalBook.width <= viewport.width
            );
            await page.screenshot({
              path: join(evidence, `${label}-keyboard-end.png`),
              fullPage: true,
              animations: 'disabled',
            });
          }
          results.push({ label, ...geometry, elapsedMs: performance.now() - started });
          await page.getByRole('button', { name: 'Rimuovi allegato', exact: true }).click();
          await shelf.waitFor({ state: 'detached' });
        }
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-home-chat-target=attachment]').click();
    await (await chooser).setFiles([
      {
        name: 'Reduced-motion.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Synthetic source'),
      },
    ]);
    const first = page.locator('.source-shelf-item').first();
    await first.waitFor();
    const resting = await first
      .locator('.source-book')
      .evaluate(element => getComputedStyle(element).transform);
    await first.focus();
    await first.hover();
    assert.equal(
      await first.locator('.source-book').evaluate(element => getComputedStyle(element).transform),
      resting
    );
    assert.equal(
      await first
        .locator('.source-book')
        .evaluate(element => getComputedStyle(element).transitionDuration),
      '0s'
    );
    assert.equal(await first.evaluate(element => getComputedStyle(element).animationName), 'none');
    assert.deepEqual(errors, []);
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify({ results, contrasts, reducedMotion: 'passed', pageErrors: errors }, null, 2)
    );
  }
);
console.log('Source shelf: 12 upload/remove scenes, keyboard overflow and reduced motion passed.');
