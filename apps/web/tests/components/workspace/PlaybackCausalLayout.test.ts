import path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { withMutedAudio } from '../../../../../scripts/browser-audio';
import viteConfig from '../../../vite.config.ts';

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  const config = viteConfig({ command: 'serve', mode: 'test' });
  server = await createServer({
    ...config,
    configFile: false,
    root: path.resolve('apps/web'),
    optimizeDeps: { entries: ['tests/fixtures/playbackLayout.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  browser = await chromium.launch(withMutedAudio({ headless: true }));
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function expectConnectedCards(page: Page) {
  await page.waitForFunction(() => {
    const flow = document.querySelector<HTMLElement>('.causal-grid');
    if (!flow) return false;
    const cards = [...flow.querySelectorAll<HTMLElement>(':scope > .cause')];
    const paths = [...document.querySelectorAll<SVGPathElement>('.causal-flow .causal-connection')];
    if (paths.length !== cards.length - 1) return false;
    const stroke = Number.parseFloat(getComputedStyle(flow).getPropertyValue('--connector-width'));
    return paths.every((path, index) => {
      const from = cards[index];
      const to = cards[index + 1];
      const sameRow = from.offsetTop === to.offsetTop;
      const start = {
        x: from.offsetLeft + (sameRow ? from.offsetWidth : from.offsetWidth / 2),
        y: from.offsetTop + (sameRow ? from.offsetHeight / 2 : from.offsetHeight),
      };
      const end = {
        x: to.offsetLeft + (sameRow ? 0 : to.offsetWidth / 2),
        y: to.offsetTop + (sameRow ? to.offsetHeight / 2 : 0),
      };
      const first = path.getPointAtLength(0);
      // The routed line ends before the separate arrowhead subpath begins.
      const distance = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
      const last = path.getPointAtLength(distance);
      return (
        Math.abs(first.x - start.x) <= stroke &&
        Math.abs(first.y - start.y) <= stroke &&
        Math.abs(last.x - end.x) <= stroke &&
        Math.abs(last.y - end.y) <= stroke
      );
    });
  });
}

test('finishes voice cue fades at word start while captions retain their 1.3 second lead', async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'no-preference',
  });
  try {
    await page.goto(`${baseUrl}tests/fixtures/playbackOnset.html`);
    await page.locator('[data-motion-id]').first().waitFor({ state: 'attached' });
    const result = await page.evaluate(async () => {
      const controls = window as unknown as { setPlaybackTime: (time: number) => void };
      const frame = () => new Promise(requestAnimationFrame);
      const words = [...document.querySelectorAll<HTMLElement>('.caption-word')];
      const reveal = document.querySelector<HTMLElement>('[data-motion-id="item:0"]');
      const focus = document.querySelector<HTMLElement>('[data-motion-id="item:1"]');
      const paragraph = document.querySelector<HTMLElement>('.caption-page');
      if (!reveal || !focus || !paragraph) throw new Error('Playback cue targets must exist');
      controls.setPlaybackTime(1);
      await frame();
      await frame();
      const width = words.reduce((sum, word) => sum + word.getBoundingClientRect().width, 0);
      const feather = Number.parseFloat(
        getComputedStyle(paragraph).getPropertyValue('--caption-feather')
      );
      const captionEdge = Number.parseFloat(words[1].style.getPropertyValue('--reveal-edge'));
      const before = {
        opacity: Number(getComputedStyle(reveal).opacity),
        emphasis: Number(focus.style.getPropertyValue('--motion-emphasis')),
      };
      controls.setPlaybackTime(1.65);
      await frame();
      await frame();
      const duringFade = {
        opacity: Number(getComputedStyle(reveal).opacity),
        emphasis: Number(focus.style.getPropertyValue('--motion-emphasis')),
      };
      controls.setPlaybackTime(2);
      await frame();
      await frame();
      return {
        before,
        duringFade,
        atWordStart: {
          opacity: Number(getComputedStyle(reveal).opacity),
          emphasis: Number(focus.style.getPropertyValue('--motion-emphasis')),
        },
        captionLead:
          ((captionEdge + words[0].getBoundingClientRect().width) / (width + feather)) * 6 - 1,
      };
    });
    expect(result.before).toEqual({ opacity: 0, emphasis: 0 });
    expect(result.duringFade.opacity).toBeCloseTo(0.5);
    expect(result.duringFade.emphasis).toBeGreaterThan(0);
    expect(result.duringFade.emphasis).toBeLessThan(1);
    expect(result.atWordStart).toEqual({ opacity: 1, emphasis: 1 });
    expect(result.captionLead).toBeCloseTo(1.3);
    for (const mode of ['path', 'formula']) {
      await page.goto(`${baseUrl}tests/fixtures/playbackOnset.html?mode=${mode}`);
      await page.locator('.scene').waitFor({ state: 'attached' });
      const state = await page.evaluate(async () => {
        const controls = window as unknown as { setPlaybackTime: (time: number) => void };
        const frame = () => new Promise(requestAnimationFrame);
        controls.setPlaybackTime(1.99);
        await frame();
        await frame();
        const before = {
          step: document.querySelector('[data-stop="1"]')?.classList.contains('current') ?? false,
          symbol:
            document.querySelector('[data-formula-symbol]')?.getAttribute('data-active') === 'true',
        };
        controls.setPlaybackTime(2);
        await frame();
        await frame();
        const stop = document.querySelector<HTMLElement>('[data-stop="1"]');
        return {
          before,
          step: stop?.classList.contains('current') ?? false,
          transition: stop ? getComputedStyle(stop).transitionDuration : null,
          symbol:
            document.querySelector('[data-formula-symbol]')?.getAttribute('data-active') === 'true',
          definitionVisible: document.querySelector('dd')?.hidden === false,
        };
      });
      if (mode === 'path') {
        expect(state.before.step).toBe(false);
        expect(state.step).toBe(true);
        expect(state.transition?.split(',').some(duration => duration.trim() === '0.3s')).toBe(
          true
        );
      } else {
        expect(state.before.symbol).toBe(false);
        expect(state.symbol).toBe(true);
        expect(state.definitionVisible).toBe(true);
      }
    }
    await page.goto(`${baseUrl}tests/fixtures/playbackOnset.html?mode=cards`);
    await page.locator('.scene-host annotation').waitFor({ state: 'attached' });
    const cards = await page.evaluate(async () => {
      const controls = window as unknown as { setPlaybackTime: (time: number) => void };
      const selected: (string | null | undefined)[] = [];
      for (const time of [1.99, 2.01, 7.99, 8.01, 2.01]) {
        controls.setPlaybackTime(time);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        selected.push(document.querySelector('.scene-host annotation')?.textContent);
      }
      return selected;
    });
    expect(cards).toEqual(['a', 'b', 'b', 'a', 'b']);
    await page.goto(`${baseUrl}tests/fixtures/playbackOnset.html?mode=fallback`);
    await page.locator('.scene').waitFor({ state: 'attached' });
    expect(
      await page.locator('.scene').evaluate(element => getComputedStyle(element).animationDuration)
    ).toBe('0.18s');
  } finally {
    await page.close();
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`fits an ordered causal grid and its row-turn connectors at ${viewport.width}x${viewport.height}`, async () => {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    try {
      await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html`);
      await page.locator('.cause').first().waitFor();
      const layout = await page.evaluate(() => {
        const slot = document.querySelector('.scene-fit');
        const caption = document.querySelector('.captions');
        if (!slot || !caption) throw new Error('Playback stage must exist');
        const cards = [...document.querySelectorAll('.causal > .cause')];
        const [slotBounds, captionBounds, ...cardBounds] = [slot, caption, ...cards].map(
          element => {
            const r = element.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
          }
        );
        return {
          slot: slotBounds,
          caption: captionBounds,
          cards: cards.map((card, index) => ({
            ...cardBounds[index],
            label: card.querySelector('strong')?.textContent,
            number: card.querySelector('.step-index')?.textContent,
          })),
        };
      });
      expect(layout.cards.map(card => card.label)).toEqual([
        'Sorgente C',
        'Libreria C',
        'ABI del kernel',
        'Kernel Linux',
      ]);
      if (viewport.width === 1440) {
        expect(layout.cards[2].top).toBeGreaterThan(layout.cards[0].bottom);
        expect(layout.cards[0].top).toBe(layout.cards[1].top);
        expect(layout.cards[2].top).toBe(layout.cards[3].top);
        expect(layout.caption.right).toBeLessThan(layout.slot.left);
      } else {
        for (let index = 1; index < layout.cards.length; index++) {
          expect(layout.cards[index].top).toBeGreaterThan(layout.cards[index - 1].bottom);
        }
      }
      expect(layout.cards.map(card => card.number)).toEqual(['01', '02', '03', '04']);
      await expectConnectedCards(page);
      const paths = await page
        .locator('.causal-connection')
        .evaluateAll(elements => elements.map(element => element.getAttribute('d')));
      expect(paths).toHaveLength(3);
      // The second connection must turn down and across to the third card on desktop.
      expect(paths[1]).toContain('V');
      for (const card of layout.cards) {
        expect(card.left).toBeGreaterThanOrEqual(layout.slot.left);
        expect(card.right).toBeLessThanOrEqual(layout.slot.right);
        expect(card.top).toBeGreaterThanOrEqual(layout.slot.top);
        expect(card.bottom).toBeLessThanOrEqual(layout.slot.bottom);
      }
      await page.setViewportSize(
        viewport.width === 1440 ? { width: 390, height: 844 } : { width: 1440, height: 900 }
      );
      await expectConnectedCards(page);
    } finally {
      await page.close();
    }
  });
}
