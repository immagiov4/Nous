import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { withMutedAudio } from '../../../../../scripts/browser-audio';
import viteConfig from '../../../vite.config';

const output = await realpath(await mkdtemp(path.join(tmpdir(), 'nous-playback-focus-')));
try {
  const config = viteConfig({ command: 'build', mode: 'test' });
  await build({
    ...config,
    configFile: false,
    plugins: [
      ...(config.plugins ?? []),
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
      for (const width of [1920, 1440, 1024, 390]) {
        for (const dark of [false, true]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(
            `${base}tests/fixtures/playbackFocus.html?${new URLSearchParams({ ...(dark ? { dark: '' } : {}), ...(width < 768 ? { mobile: '' } : {}) })}`
          );
          await page.getByRole('button', { name: 'Riproduci', exact: true }).click();
          const track = page.getByRole('slider', { name: 'Posizione audio' });
          if (width < 768) await page.getByRole('button', { name: 'Pausa', exact: true }).click();
          await track.waitFor({ state: 'visible' });
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
              ...(getComputedStyle(hint).display === 'none' ? [] : [hint]),
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
