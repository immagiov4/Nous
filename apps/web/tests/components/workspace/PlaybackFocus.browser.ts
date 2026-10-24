import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
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
    for (const engine of [chromium, firefox]) {
      const browser = await engine.launch(withMutedAudio({ headless: true }));
      try {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 900 },
          reducedMotion: 'reduce',
        });
        await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'mediaDevices', {
            value: {
              getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
            },
          });
          class Recorder {
            static isTypeSupported() {
              return true;
            }
            mimeType = 'audio/webm';
            state = 'inactive';
            ondataavailable: ((event: { data: Blob }) => void) | null = null;
            onstop: (() => void) | null = null;
            start() {
              this.state = 'recording';
              document.documentElement.dataset.recording = 'true';
            }
            stop() {
              this.state = 'inactive';
              document.documentElement.dataset.recording = 'false';
              this.ondataavailable?.({ data: new Blob(['synthetic']) });
              this.onstop?.();
            }
          }
          Object.defineProperty(window, 'MediaRecorder', { value: Recorder });
        });
        await page.goto(`${base}tests/fixtures/playbackFocus.html`);
        await page.evaluate(() => scrollTo(0, 250));
        const scroll = await page.evaluate(() => scrollY);
        await page.getByRole('button', { name: 'Riproduci', exact: true }).click();
        const player = page.getByRole('dialog', { name: 'Riproduci lezione', exact: true });
        await player.waitFor();
        assert(await player.evaluate(element => element === document.activeElement));
        assert.equal(await page.evaluate(() => scrollY), scroll);
        assert.equal(
          await player.evaluate(element => getComputedStyle(element).outlineWidth),
          '0px'
        );
        await page.keyboard.press('Shift+Tab');
        assert(
          await player
            .getByRole('button', { name: 'Nota', exact: true })
            .evaluate(element => element === document.activeElement)
        );
        await page.keyboard.press('Tab');
        const back = page.getByRole('button', { name: 'Torna alla lezione' });
        assert(
          await back.evaluate(
            element => element === document.activeElement && element.matches(':focus-visible')
          )
        );
        await page.keyboard.press('Shift+Tab');
        assert(
          await player.evaluate(element => {
            const controls = Array.from(
              element.querySelectorAll<HTMLElement>(
                'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]'
              )
            ).filter(control => !control.closest('[inert]') && control.getClientRects().length > 0);
            return document.activeElement === controls.at(-1);
          })
        );
        await page.keyboard.press('Tab');
        assert(await back.evaluate(element => element === document.activeElement));
        // Reopening through the keyboard must also leave the surface outline-free.
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await player.waitFor();
        assert(await player.evaluate(element => element === document.activeElement));
        assert.equal(
          await player.evaluate(element => getComputedStyle(element).outlineWidth),
          '0px'
        );
        await page.keyboard.down('Space');
        await page.waitForFunction(() => document.documentElement.dataset.recording === 'true');
        assert(
          await player.getByRole('button', { name: /Riproduci|TTS non disponibile/ }).isDisabled()
        );
        await page.keyboard.up('Space');
        await page.getByRole('button', { name: 'Chiudi', exact: true }).click();
        assert(await player.evaluate(element => element === document.activeElement));
        const question = page.getByRole('textbox');
        await question.fill('Una');
        await page.keyboard.press('Space');
        await page.keyboard.type('domanda');
        assert.equal(await question.inputValue(), 'Una domanda');
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.recording),
          'false'
        );
        const speed = page.getByRole('button', { name: 'Velocita', exact: true });
        await speed.click();
        await page.getByRole('slider', { name: 'Velocita', exact: true }).focus();
        await page.keyboard.press('Escape');
        assert(await player.evaluate(element => element === document.activeElement));
        await speed.click();
        await question.click();
        assert(await question.evaluate(element => element === document.activeElement));
        await page.keyboard.press('Space');
        assert.equal(await question.inputValue(), 'Una domanda ');
        await speed.click();
        assert.equal(await speed.getAttribute('aria-expanded'), 'false');
        assert(await player.evaluate(element => element === document.activeElement));
        await speed.click();
        assert.equal(await speed.getAttribute('aria-expanded'), 'true');
        await speed.click();
        assert.equal(await speed.getAttribute('aria-expanded'), 'false');
        await page.waitForFunction(
          () =>
            document.activeElement ===
            document.querySelector('dialog[aria-label="Riproduci lezione"]')
        );
        assert(await player.evaluate(element => element === document.activeElement));
        await speed.click();
        await player.getByRole('heading', { name: 'Prova del fuoco', exact: true }).click();
        assert.equal(await speed.getAttribute('aria-expanded'), 'false');
        assert(await player.evaluate(element => element === document.activeElement));
        await page.reload();
        await page.getByRole('button', { name: 'Riproduci', exact: true }).click();
        assert(await player.evaluate(element => element === document.activeElement));
        await page.goto(`${base}tests/fixtures/playbackFocus.html?mobile`);
        await page.getByRole('button', { name: 'Riproduci', exact: true }).click();
        assert(await back.evaluate(element => element === document.activeElement));
        console.log(
          `PASS ${engine.name()}: initial/reload focus, voice capture, text spaces, Tab, menus, mobile`
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
