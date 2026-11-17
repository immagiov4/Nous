import { type Browser, chromium, devices, type Locator } from 'playwright';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { withMutedAudio } from '../../../../../scripts/browser-audio';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch(withMutedAudio({ headless: true }));
});

afterAll(async () => {
  await browser?.close();
});

const contexts = [
  { device: 'desktop', colorScheme: 'light' },
  { device: 'desktop', colorScheme: 'dark' },
  { device: 'mobile', colorScheme: 'light' },
  { device: 'mobile', colorScheme: 'dark' },
] as const;

const labels = (graphic: Locator, selector: string) =>
  graphic.locator(selector).evaluateAll(elements =>
    elements.map(element => {
      const label = element as SVGGraphicsElement;
      const svgElement =
        label instanceof SVGGraphicsElement ? label : element.closest('foreignObject');
      const matrix = svgElement?.getScreenCTM();
      const bounds = label.getBoundingClientRect();
      if (!matrix) throw new Error('Visible graphic label must have a screen transform.');
      return {
        text: label.textContent,
        px: Math.hypot(matrix.c, matrix.d) * Number.parseFloat(getComputedStyle(label).fontSize),
        left: bounds.left,
        right: bounds.right,
      };
    })
  );

const readingSize = (scene: Locator) =>
  scene.evaluate(element =>
    Number.parseFloat(getComputedStyle(element).getPropertyValue('--diagram-copy'))
  );

test.each(contexts)('keeps reader graphics readable in $device $colorScheme', async ({
  device,
  colorScheme,
}) => {
  const mobile = device === 'mobile';
  const context = await browser.newContext({
    ...(mobile ? devices['Pixel 7'] : {}),
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  try {
    await page.goto(`${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html`);
    const dense = page.locator('.type-flowchart').first();
    const short = page.locator('.type-flowchart').last();
    const flowchart = async (scene: Locator, title: string, connections: number) => {
      const graphic = scene.getByRole('img', { name: title });
      await graphic.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const nodes = await labels(graphic, '.node text, .node foreignObject .nodeLabel');
      expect(nodes).toHaveLength(scene === dense ? 8 : 4);
      const measured = [...nodes, ...(await labels(graphic, '.edgeLabel text'))];
      expect(measured.map(label => label.text)).toEqual(expect.arrayContaining(['Yes', 'No']));
      expect
        .soft(Math.round(Math.min(...measured.map(label => label.px))), title)
        .toBeGreaterThanOrEqual(await readingSize(scene));
      expect(await graphic.locator('path.flowchart-link[marker-end]').count()).toBe(connections);
      expect(await scene.getByRole('listitem').count()).toBe(connections);
      if (connections > 3) {
        expect(await scene.getByRole('listitem').allTextContents()).toContain(
          'Review the measurement setup → Repeat the measurement sequence: Try again'
        );
      }
      return scene.getByRole('region', { name: new RegExp(title) });
    };
    const denseRegion = await flowchart(dense, 'Verify an observation', 8);
    const shortRegion = await flowchart(short, 'Check a result', 3);
    expect(await shortRegion.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
    if (!mobile) {
      await denseRegion.focus();
      await denseRegion.press('ArrowRight');
      await expect
        .poll(() => denseRegion.evaluate(el => el.scrollLeft), { timeout: 1000 })
        .toBeGreaterThan(0);
      await denseRegion.evaluate(el => {
        el.scrollLeft = 0;
      });
    }

    for (const type of ['radar', 'polar', 'scatter']) {
      const scene = page.locator(`.type-${type}`);
      const title = await scene.getByRole('heading', { level: 2 }).innerText();
      const chart = scene.getByRole('img', { name: title });
      const measured = await labels(chart, type === 'scatter' ? 'text' : 'text > tspan');
      const sceneBounds = await page
        .locator('figure.lesson-scene')
        .filter({ has: scene })
        .boundingBox();
      if (!sceneBounds) throw new Error('The chart scene must be visible.');
      expect
        .soft(Math.round(Math.min(...measured.map(label => label.px))), type)
        .toBeGreaterThanOrEqual(await readingSize(scene));
      expect
        .soft(
          measured.filter(
            label =>
              label.left < sceneBounds.x - 1 || label.right > sceneBounds.x + sceneBounds.width + 1
          ),
          type
        )
        .toEqual([]);
    }
    expect(
      await page.locator('.type-radar').getByRole('img').locator('desc').textContent()
    ).toContain('Tracciabilità: 4 / 5 punti');
    expect(
      await page.locator('.type-polar').getByRole('img').locator('desc').textContent()
    ).toContain('18–24: 40 / 100 richieste');
    expect(
      await page.locator('.type-scatter').getByRole('img').locator('desc').textContent()
    ).toContain('Prova D: Richieste al secondo 80, Tempo di risposta (ms) 170');

    for (const [type, title] of [
      ['network', 'Weather observations'],
      ['hierarchy', 'Observation records'],
    ]) {
      const scene = page.locator(`.type-${type}`);
      expect.soft(await scene.getByText(title, { exact: true }).count()).toBe(1);
      expect(await scene.getByRole('heading', { name: title }).count()).toBe(1);
      expect(await scene.getByText('Amount over time').count()).toBe(1);
    }

    if (mobile) {
      const gaps = await page.locator('.network').evaluate(network => {
        const root = network.querySelector('.hub');
        if (!root) throw new Error('The network must contain a root.');
        const stemEnd = (element: Element) => {
          const stem = getComputedStyle(element, '::after');
          const bounds = element.getBoundingClientRect();
          return bounds.top + Number.parseFloat(stem.top) + Number.parseFloat(stem.height);
        };
        const satellites = [...network.querySelectorAll('.satellites > .concept')];
        return satellites.map((satellite, index) => {
          const branch = getComputedStyle(satellite, '::before');
          const branchStart = satellite.getBoundingClientRect().top + Number.parseFloat(branch.top);
          return Math.round(branchStart - stemEnd(satellites[index - 1] ?? root));
        });
      });
      expect.soft(gaps).toEqual([0, 0, 0]);
    }
  } finally {
    await context.close();
  }
});
