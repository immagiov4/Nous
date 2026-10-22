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

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.each([
    'reduce',
    'no-preference',
  ] as const)(`shows full-width progressive captions without a scene at ${viewport.width}x${viewport.height} (%s)`, async reducedMotion => {
    const page = await browser.newPage({ viewport, reducedMotion });
    try {
      await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?captionOnly`);
      await page.locator('.caption-page').waitFor({ state: 'attached' });
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.caption-word')].some(
          word => getComputedStyle(word).opacity === '1'
        )
      );
      expect(await page.locator('.captions').isVisible()).toBe(true);
      expect(await page.locator('.scene-host').count()).toBe(0);
      const layout = await page.evaluate(() => {
        const caption = document.querySelector('.caption-page');
        const stage = document.querySelector('.listening-stage');
        if (!caption || !stage) throw new Error('Captions must exist');
        const words = [...caption.querySelectorAll('.caption-word')];
        return {
          width: caption.getBoundingClientRect().width,
          stageWidth: stage.getBoundingClientRect().width,
          visible: words.filter(word => getComputedStyle(word).opacity === '1').length,
          hidden: words.filter(word => getComputedStyle(word).opacity === '0').length,
        };
      });
      expect(layout.width).toBeCloseTo(layout.stageWidth, 0);
      expect(layout.visible).toBeGreaterThan(0);
      expect(layout.hidden).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
}
