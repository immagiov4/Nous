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

const networkGaps = (network: Locator) =>
  network.evaluate(element => {
    const root = element.querySelector<HTMLElement>('.hub');
    if (!root) throw new Error('The network must contain a root.');
    const scale = root.getBoundingClientRect().height / root.offsetHeight;
    const stemEnd = (stemOwner: Element) => {
      const stem = getComputedStyle(stemOwner, '::after');
      return (
        stemOwner.getBoundingClientRect().top +
        (Number.parseFloat(stem.top) + Number.parseFloat(stem.height)) * scale
      );
    };
    const satellites = [...element.querySelectorAll('.satellites > .concept')];
    return satellites.map((satellite, index) => {
      const branch = getComputedStyle(satellite, '::before');
      const branchStart =
        satellite.getBoundingClientRect().top + Number.parseFloat(branch.top) * scale;
      return Math.round(branchStart - stemEnd(satellites[index - 1] ?? root));
    });
  });

async function expectHorizontalScrollbar(dense: Locator, short: Locator, mobile: boolean) {
  const bar = dense.locator('..').getByRole('slider');
  const page = dense.page();
  const scrollLeft = () => dense.evaluate(element => element.scrollLeft);
  const maximum = await dense.evaluate(element => element.scrollWidth - element.clientWidth);
  expect(maximum).toBeGreaterThan(0);
  expect(await bar.isVisible(), 'overflow is discoverable before any input').toBe(true);
  expect(await short.locator('..').getByRole('slider').count()).toBe(0);
  expect(await bar.inputValue()).toBe('0');

  await dense.evaluate(element => {
    element.scrollLeft = Math.floor((element.scrollWidth - element.clientWidth) / 2);
  });
  await expect.poll(async () => Number(await bar.inputValue())).toBe(Math.floor(maximum / 2));
  await bar.press('End');
  await expect.poll(scrollLeft).toBe(maximum);
  await bar.press('Home');
  await expect.poll(scrollLeft).toBe(0);

  if (!mobile) {
    await bar.scrollIntoViewIfNeeded();
    const bounds = await bar.boundingBox();
    if (!bounds) throw new Error('The scrollbar must be available to drag.');
    const thumbFraction = await dense.evaluate(el => el.clientWidth / el.scrollWidth);
    const grabX = bounds.x + (bounds.width * thumbFraction) / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(grabX, y);
    await page.mouse.down();
    await page.mouse.move(grabX + bounds.width * (1 - thumbFraction), y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(scrollLeft).toBeGreaterThan(maximum / 2);
    await bar.press('Home');
  }
}

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
    await expectHorizontalScrollbar(denseRegion, shortRegion, mobile);
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
      const measured = await labels(
        chart,
        type === 'scatter' ? 'text, .q-scatter-point-label' : 'text > tspan'
      );
      expect(measured.length, type).toBeGreaterThan(0);
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
      expect.soft(await networkGaps(page.locator('.network'))).toEqual([0, 0, 0]);
    }
  } finally {
    await context.close();
  }
});

test('fits a dense diagram to the playback card width', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html?playback`);
    const graphic = page.getByRole('img', { name: 'Verify an observation' });
    await graphic.waitFor();
    expect(await page.getByRole('slider').count()).toBe(0);
    const overflow = await graphic.evaluate(
      svg => svg.getBoundingClientRect().width - (svg.parentElement?.clientWidth ?? 0)
    );
    expect(overflow).toBeLessThanOrEqual(1);
  } finally {
    await page.close();
  }
});

test.each([
  'network',
  'hierarchy',
] as const)('keeps the %s root sized in compact playback', async type => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    await page.goto(
      inject('browserFixtureUrl') + 'tests/fixtures/readerGraphics.html?playback=' + type
    );
    const heading = page.locator(type === 'network' ? '.hub h2' : '.root-node h2');
    await heading.waitFor();
    const sizes = await heading.evaluate(node => [
      getComputedStyle(node).fontSize,
      getComputedStyle(node.parentElement!).fontSize,
    ]);
    expect.soft(sizes[0]).toBe(sizes[1]);
    if (type === 'network') expect(await networkGaps(page.locator('.network'))).toEqual([0, 0, 0]);
  } finally {
    await page.close();
  }
});

test('keeps long scatter labels readable through an in-chart marker and a chart key', async () => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    await page.goto(inject('browserFixtureUrl') + 'tests/fixtures/readerGraphics.html?long-label');
    const plot = page.locator('.type-scatter');
    const graphic = plot.getByRole('img');
    await graphic.waitFor();
    const authored = plot.getByRole('list').getByText(/^Control trial after recalibration,/);
    expect(await authored.isVisible()).toBe(true);
    expect(await authored.textContent()).toMatch(/within tolerance$/);
    const marker = graphic.locator('foreignObject').getByText('5', { exact: true });
    const [viewport, label] = await Promise.all([graphic.boundingBox(), marker.boundingBox()]);
    if (!viewport || !label) throw new Error('The long label and its chart must be visible.');
    expect(label.x).toBeGreaterThanOrEqual(viewport.x);
    expect(label.x + label.width).toBeLessThanOrEqual(viewport.x + viewport.width);
    expect(label.y).toBeGreaterThanOrEqual(viewport.y);
    expect(label.y + label.height).toBeLessThanOrEqual(viewport.y + viewport.height);
  } finally {
    await page.close();
  }
});
