import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { build, preview } from 'vite';
import { withMutedAudio } from '../../../../../scripts/browser-audio';
import viteConfig from '../../../vite.config';

function focusOutline(element: Element) {
  const style = getComputedStyle(element);
  const rules: string[] = [];
  const inspect = (list: CSSRuleList) => {
    for (const rule of list) {
      if (rule instanceof CSSStyleRule && element.matches(rule.selectorText) && rule.style.outline)
        rules.push(rule.cssText);
      if ('cssRules' in rule) inspect((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) inspect(sheet.cssRules);
  return {
    width: style.outlineWidth,
    style: style.outlineStyle,
    color: style.outlineColor,
    focusVisible: element.matches(':focus-visible'),
    rules,
    classes: element.className,
  };
}

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
        for (const mobileTheme of [false, true]) {
          await page.setViewportSize(
            mobileTheme ? { width: 390, height: 844 } : { width: 1440, height: 900 }
          );
          for (const dark of [true, false]) {
            await page.goto(
              `${base}tests/fixtures/playbackFocus.html?${new URLSearchParams({ ...(dark ? { dark: '' } : {}), ...(mobileTheme ? { mobile: '' } : {}) })}`
            );
            await page.getByRole('button', { name: 'Riproduci', exact: true }).click();
            const voice = page.getByRole('combobox', { name: 'Voce', exact: true });
            const palette = await voice.evaluate(element => {
              const style = getComputedStyle(element);
              const firstOption = element.querySelector('option');
              if (!firstOption) throw new Error('Voice picker requires an option');
              const option = getComputedStyle(firstOption);
              return {
                scheme: style.colorScheme,
                background: option.backgroundColor,
                foreground: option.color,
              };
            });
            assert.equal(palette.scheme, dark ? 'dark' : 'light');
            assert.equal(palette.background, dark ? 'rgb(39, 39, 42)' : 'rgb(255, 255, 255)');
            assert.equal(palette.foreground, dark ? 'rgb(228, 228, 231)' : 'rgb(55, 65, 81)');
            await voice.focus();
            const spaceAllowed = await voice.evaluate(element =>
              element.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key: ' ',
                  code: 'Space',
                  bubbles: true,
                  cancelable: true,
                })
              )
            );
            assert(spaceAllowed, 'Focused native select retains Space');
            await page.keyboard.press('Alt+ArrowDown');
            assert(await voice.evaluate(element => element.matches(':open')));
            await page.keyboard.down('Space');
            assert.notEqual(
              await page.evaluate(() => document.documentElement.dataset.recording),
              'true'
            );
            await page.keyboard.up('Space');
            await page.keyboard.press('Tab');
            await voice.focus();
            await page.keyboard.press('Home');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            assert.equal(await voice.inputValue(), 'Puck');
            console.log(
              `PASS ${engine.name()} ${mobileTheme ? 'mobile' : 'desktop'} ${dark ? 'dark' : 'light'} native voice theme and keyboard selection`
            );
          }
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`${base}tests/fixtures/playbackFocus.html`);
        await page.evaluate(() => scrollTo(0, 250));
        const scroll = await page.evaluate(() => scrollY);
        await page.getByRole('button', { name: 'Riproduci', exact: true }).click();
        const player = page.getByRole('dialog', { name: 'Riproduci lezione', exact: true });
        await player.waitFor();
        assert(await player.evaluate(element => element === document.activeElement));
        assert.equal(await page.evaluate(() => scrollY), scroll);
        const openingOutline = await player.evaluate(focusOutline);
        assert.equal(openingOutline.width, '0px', JSON.stringify(openingOutline));
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
        const controlOutline = await back.evaluate(focusOutline);
        assert.notEqual(controlOutline.style, 'none', JSON.stringify(controlOutline));
        assert(Number.parseFloat(controlOutline.width) > 0, JSON.stringify(controlOutline));
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
        const reopenedOutline = await player.evaluate(focusOutline);
        assert.equal(reopenedOutline.width, '0px', JSON.stringify(reopenedOutline));
        console.log(
          JSON.stringify({
            browser: engine.name(),
            openingOutline,
            reopenedOutline,
            controlOutline,
          })
        );
        const forward = player.getByRole('button', { name: 'Avanti di 5 secondi' });
        await forward.focus();
        await page.keyboard.press('Enter');
        const timeline = player.getByRole('slider', { name: 'Posizione audio' });
        assert.equal(await timeline.inputValue(), '5');
        await player.getByRole('button', { name: 'Indietro di 5 secondi' }).focus();
        await page.keyboard.press('Enter');
        assert.equal(await timeline.inputValue(), '0');
        await page.keyboard.press('Enter');
        assert.equal(await timeline.inputValue(), '0');
        for (let skip = 0; skip < 3; skip++) {
          await forward.focus();
          await page.keyboard.press('Enter');
        }
        assert.equal(await timeline.inputValue(), '12');
        await player.getByRole('button', { name: 'Indietro di 5 secondi' }).focus();
        await page.keyboard.press('Enter');
        assert.equal(await timeline.inputValue(), '7');
        await timeline.focus();
        await page.keyboard.press('Home');
        assert.equal(await timeline.inputValue(), '0');
        await page.keyboard.press('ArrowRight');
        assert(Number(await timeline.inputValue()) > 0);
        const speedControl = player.getByRole('button', { name: 'Velocita', exact: true });
        await speedControl.focus();
        await page.keyboard.press('Enter');
        await player.getByRole('slider', { name: 'Velocita', exact: true }).focus();
        await page.keyboard.press('ArrowRight');
        assert.equal(await speedControl.textContent(), '1.05x');
        await page.keyboard.press('Escape');
        await back.focus();
        await back.evaluate(element => {
          element.addEventListener('click', () => {
            element.dataset.spaceClicked = 'true';
          });
        });
        await page.keyboard.down('Space');
        await page.waitForFunction(() => document.documentElement.dataset.recording === 'true');
        assert(
          await player.getByRole('button', { name: /Riproduci|TTS non disponibile/ }).isDisabled()
        );
        await page.keyboard.up('Space');
        assert.equal(await back.getAttribute('data-space-clicked'), null);
        assert(await player.isVisible());
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
