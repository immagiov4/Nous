import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build, loadConfigFromFile, preview } from 'vite';
import { withMutedAudio } from '../../../../../scripts/browser-audio.ts';

const output = await realpath(await mkdtemp(path.join(tmpdir(), 'nous-playback-focus-')));
try {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'test' },
    path.resolve('apps/web/vite.config.ts')
  );
  assert(loaded, 'Playback fixture must load the web Vite config');
  await build({
    ...loaded.config,
    configFile: false,
    plugins: [
      ...(loaded.config.plugins ?? []),
      {
        name: 'synthetic-narration',
        enforce: 'pre',
        resolveId(source, importer) {
          if (
            importer?.endsWith('/playback/LessonPlayer.tsx') &&
            source.endsWith('/useLessonPlayback.ts')
          )
            return path.resolve('apps/web/tests/fixtures/playbackFocusTransport.ts');
        },
      },
    ],
    logLevel: 'error',
    build: {
      outDir: output,
      rollupOptions: { input: path.resolve('apps/web/tests/fixtures/playbackFocus.html') },
    },
  });
  const server = await preview({
    configFile: false,
    root: path.resolve('apps/web'),
    build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  try {
    const base = server.resolvedUrls?.local[0];
    assert(base);
    const browser = await chromium.launch(withMutedAudio({ headless: true }));
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' });
      await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
      for (const width of [1920, 1440, 1280, 1024, 390]) {
        for (const dark of [false, true]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(
            `${base}tests/fixtures/playbackFocus.html?${new URLSearchParams({ ...(dark ? { dark: '' } : {}), ...(width < 768 ? { mobile: '' } : {}) })}`
          );
          await page.getByRole('button', { name: 'Riproduci', exact: true }).click();
          const track = page.getByRole('slider', { name: 'Posizione audio' });
          if (width < 768) await page.getByRole('button', { name: 'Pausa', exact: true }).click();
          await track.waitFor({ state: 'visible' });
          await page.waitForFunction(() => {
            const hint = [...document.querySelectorAll('p')].find(p =>
              p.textContent?.includes('Tieni premuto')
            );
            if (!hint || getComputedStyle(hint).display === 'none') return true;
            const text = hint.firstElementChild;
            return (
              text &&
              Number(getComputedStyle(hint).opacity) ===
                (hint.clientWidth >= text.scrollWidth ? 1 : 0)
            );
          });
          const layout = await track.evaluate(element => {
            const controls =
              element.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;
            const hint = [...document.querySelectorAll('p')].find(p =>
              p.textContent?.includes('Tieni premuto')
            );
            if (!controls || !hint?.firstElementChild || !hint.parentElement)
              throw new Error('Playback bar must exist');
            return {
              controlsHeight: controls.getBoundingClientRect().height,
              barHeight: hint.parentElement.getBoundingClientRect().height,
              fits: hint.clientWidth >= hint.firstElementChild.scrollWidth,
              visible: getComputedStyle(hint).opacity === '1',
              desktop: getComputedStyle(hint).display !== 'none',
            };
          });
          if (width >= 768) {
            // Measured on main with this fixture, including the hint's existing margins.
            assert.equal(layout.controlsHeight, 54);
            assert.equal(layout.barHeight, 98);
            assert.equal(
              layout.visible,
              layout.fits,
              `Hint visibility must follow available space at ${width}`
            );
            if (width === 1920) assert(layout.visible, 'Hint remains visible when there is room');
          }
          if (process.env.BAR_SCREENSHOTS) {
            await page.screenshot({ path: `${process.env.BAR_SCREENSHOTS}/${width}-${dark}.png` });
          }
          const boxes = await track.evaluate(element => {
            const duration = element.nextElementSibling;
            const hint = [...document.querySelectorAll('p')].find(p =>
              p.textContent?.includes('Tieni premuto')
            );
            if (!duration || !hint) throw new Error('Duration and hint must exist');
            return [
              element,
              duration,
              ...(getComputedStyle(hint).display === 'none' ||
              getComputedStyle(hint).opacity === '0'
                ? []
                : [hint]),
            ].map(node => {
              const rect = node.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
              };
            });
          });
          assert(
            boxes[0].width > boxes[1].width,
            `Track must remain wider than duration at ${width}`
          );
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i];
              const b = boxes[j];
              assert(
                a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y,
                `Control boxes ${i}/${j} overlap at ${width}, dark=${dark}: ${JSON.stringify(boxes)}`
              );
            }
          }
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
} finally {
  await rm(output, { recursive: true });
}
