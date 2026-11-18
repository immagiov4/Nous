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

test.each(
  contexts
)('renders the downward tree with details in reader and playback on $device $colorScheme', async ({
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
  try {
    const page = await context.newPage();
    for (const route of ['', '?playback=tree']) {
      await page.goto(`${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html${route}`);
      const scene = page.locator('.type-tree');
      const root = scene.getByRole('heading', { name: 'Telescope' });
      await root.waitFor();
      expect(await scene.getByText('Telescope', { exact: true }).count()).toBe(1);
      const parent = await root.boundingBox();
      if (!parent) throw new Error('The tree root must be visible.');
      const children = scene.locator('.q-tree > li > ul > li');
      const icons = await children
        .locator('.meaning-icon')
        .evaluateAll(elements => elements.map(icon => icon.getAttribute('data-icon')));
      expect(icons).toEqual(['circle', 'box', 'tripod']);
      expect(await children.allTextContents()).toEqual([
        'LensGathers light',
        'TubeKeeps the optics aligned',
        'MountHolds the telescope steady',
      ]);
      const branches = await children.evaluateAll(elements =>
        elements.map(element => ({
          y: element.getBoundingClientRect().top,
          x: element.getBoundingClientRect().left,
          joinsFork:
            ['::before', '::after'].some(pseudo => {
              const style = getComputedStyle(element, pseudo);
              return style.display !== 'none' && Number.parseFloat(style.borderLeftWidth) > 0;
            }) || Number.parseFloat(getComputedStyle(element, '::after').borderRightWidth) > 0,
        }))
      );
      expect(
        branches.every(branch => branch.y > parent.y + parent.height && branch.joinsFork)
      ).toBe(true);
      expect(branches[0].x).toBeLessThan(branches[1].x);
      expect(branches[1].x).toBeLessThan(branches[2].x);
    }
  } finally {
    await context.close();
  }
});

const numberedKey = (scene: Locator) =>
  scene
    .getByRole('list')
    .getByRole('listitem')
    .evaluateAll(items =>
      items.map(item => ({ number: (item as HTMLLIElement).value, text: item.textContent }))
    );

async function radialPlatformFonts(chart: Locator, type: 'radar' | 'polar') {
  const page = chart.page();
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const { nodeIds } = await session.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: `.type-${type} .q-radial-label > tspan`,
    });
    const nodes = await Promise.all(
      nodeIds.map(nodeId => session.send('CSS.getPlatformFontsForNode', { nodeId }))
    );
    return [...new Set(nodes.flatMap(node => node.fonts.map(font => font.familyName)))];
  } finally {
    await session.detach();
  }
}

async function expectRadialLayout(chart: Locator, type: 'radar' | 'polar', mobile: boolean) {
  const scene = chart.locator('..');
  const { labels, svg, viewport, valueToUnit, valueToGrid } = await scene.evaluate(element => {
    const graphic = element.querySelector<SVGSVGElement>('svg.q-svg') as SVGSVGElement;
    const matrix = graphic.getScreenCTM() as DOMMatrix;
    const svg = { left: matrix.e, right: matrix.e + matrix.a * graphic.viewBox.baseVal.width };
    const labels = Array.from(graphic.querySelectorAll('.q-radial-label'), label => {
      const marker = label.querySelector('.q-radial-marker') as Element;
      const showsMarker = getComputedStyle(marker).display !== 'none';
      // Measure the unabridged label even when the reader substitutes a number.
      label.removeAttribute('data-in-key');
      const name = label.firstElementChild as Element;
      const value = label.querySelector('.q-radial-value') as Element;
      const a = name.getBoundingClientRect();
      const b = value.getBoundingClientRect();
      const font = getComputedStyle(name).font;
      label.toggleAttribute('data-in-key', showsMarker);
      return {
        name: name.textContent,
        measurement: `${name.textContent}: ${value.textContent}`,
        font,
        showsMarker,
        left: Math.min(a.left, b.left),
        right: Math.max(a.right, b.right),
        lineGap: b.top - a.bottom,
        bottom: b.bottom,
      };
    });
    const unit = element.querySelector('.q-radial-unit') as Element;
    const unitText = document.createRange();
    unitText.selectNodeContents(unit);
    const grid = graphic.querySelector('circle.q-grid:last-of-type') as Element;
    return {
      labels,
      svg,
      viewport: { width: innerWidth, height: innerHeight },
      valueToUnit:
        unitText.getBoundingClientRect().top -
        Math.max(...labels.filter(label => !label.showsMarker).map(label => label.bottom)),
      valueToGrid: grid.getBoundingClientRect().top - labels[0].bottom,
    };
  });
  const authored =
    type === 'radar'
      ? [
          'Chiarezza: 4 / 5 punti',
          'Copertura: 3 / 5 punti',
          'Verifica: 5 / 5 punti',
          'Tracciabilità: 4 / 5 punti',
        ]
      : [
          '00–06: 20 / 100 richieste',
          '06–12: 60 / 100 richieste',
          '12–18: 80 / 100 richieste',
          '18–24: 40 / 100 richieste',
        ];
  expect(labels.map(label => label.measurement)).toEqual(authored);
  const fallback = labels.map(label => label.left < svg.left || label.right > svg.right);
  const mismatches = labels.filter((label, index) => label.showsMarker !== fallback[index]);
  const diagnostic =
    mismatches.length || fallback.includes(true)
      ? JSON.stringify({
          type,
          viewport,
          svg,
          labels,
          platformFonts: await radialPlatformFonts(chart, type),
        })
      : undefined;
  expect(mismatches, diagnostic).toEqual([]);
  if (diagnostic) console.info('Radial label fallback', diagnostic);
  expect(await numberedKey(scene)).toEqual(
    authored.flatMap((text, index) => (fallback[index] ? [{ number: index + 1, text }] : []))
  );
  const inline = labels.filter(label => !label.showsMarker);
  expect(inline.length).toBeGreaterThan(0);
  if (mobile) {
    expect
      .soft(Math.min(...inline.map(label => label.lineGap)), type + ' category and value')
      .toBeGreaterThan(0);
    expect.soft(valueToUnit, type + ' value and unit').toBeGreaterThan(await readingSize(scene));
    expect.soft(valueToGrid, type + ' value and plot').toBeGreaterThan(0);
  }
}

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

  if (mobile) {
    const session = await page.context().newCDPSession(page);
    const drag = async (startX: number, y: number, distance: number) => {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y }],
      });
      for (let step = 1; step <= 8; step++) {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: startX + (distance * step) / 8, y }],
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    try {
      await bar.scrollIntoViewIfNeeded();
      const track = await bar.boundingBox();
      if (!track) throw new Error('The thumb must be visible to drag.');
      const fraction = await dense.evaluate(el => el.clientWidth / el.scrollWidth);
      const startX = track.x + (track.width * fraction) / 2;
      const centerY = track.y + track.height / 2;
      await drag(startX, centerY, track.width * (1 - fraction));
      await expect
        .poll(scrollLeft, { message: 'touch drag moves the thumb and diagram' })
        .toBeGreaterThan(maximum / 2);
      expect(Number(await bar.inputValue())).toBe(await scrollLeft());
      await bar.press('Home');
      await expect.poll(scrollLeft).toBe(0);
      await dense.evaluate(element => element.scrollIntoView({ block: 'start' }));
      const plot = await dense.boundingBox();
      if (!plot) throw new Error('The diagram must be visible to swipe.');
      const x = plot.x + plot.width * 0.75;
      const y = plot.y + Math.min(plot.height / 2, 100);
      await drag(x, y, -plot.width / 3);
      await expect
        .poll(scrollLeft, { message: 'touch swipe moves the diagram' })
        .toBeGreaterThan(0);
    } finally {
      await session.detach();
    }
  } else {
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

    for (const type of ['radar', 'polar', 'scatter'] as const) {
      const scene = page.locator(`.type-${type}`);
      const title = await scene.getByRole('heading', { level: 2 }).innerText();
      const chart = scene.getByRole('img', { name: title });
      const measured = await labels(
        chart,
        type === 'scatter' ? 'text, .q-scatter-point-label' : 'text > tspan:visible'
      );
      expect(measured.length, type).toBeGreaterThan(0);
      if (type !== 'scatter') await expectRadialLayout(chart, type, mobile);
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

test('keeps four short radial labels on their rays at 390 px with a bundled font', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(inject('browserFixtureUrl') + 'tests/fixtures/readerGraphics.html');
    await page.locator('.type-radar .q-radial-label').first().waitFor();
    await page.addStyleTag({
      content: '.lesson-scene .q-radial-label { font-family: KaTeX_SansSerif; }',
    });
    for (const weight of [400, 600]) {
      const loaded = await page.evaluate(
        async weight => (await document.fonts.load(`${weight} 20px KaTeX_SansSerif`)).length,
        weight
      );
      expect(loaded).toBeGreaterThan(0);
    }
    for (const type of ['radar', 'polar'] as const) {
      const plot = page.locator(`.type-${type}`);
      await expect
        .poll(() => plot.locator('.q-radial-label > tspan:first-child:visible').count())
        .toBe(4);
      expect(await numberedKey(plot)).toEqual([]);
      await expectRadialLayout(plot.getByRole('img'), type, true);
    }
  } finally {
    await page.close();
  }
});

test('keeps full scatter axis titles readable inside the phone card', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    const axes = {
      xLabel: 'Elapsed time since the beginning of the observation period in milliseconds',
      yLabel: 'Total observations received per sampling station in the previous hour',
    };
    await page.addInitScript(axes => {
      Object.assign(window, {
        readerGraphicsScenes: [
          {
            type: 'scatter',
            title: 'Station observations',
            body: '',
            quote: '',
            note: '',
            groups: [],
            ...axes,
            items: [{ label: 'Station A', x: 1, y: 2, detail: '', icon: '' }],
          },
        ],
      });
    }, axes);
    await page.goto(inject('browserFixtureUrl') + 'tests/fixtures/readerGraphics.html');
    const plot = page.locator('.type-scatter');
    const graphic = plot.getByRole('img');
    const bounds = await plot.boundingBox();
    if (!bounds) throw new Error('The chart must be visible.');
    for (const [axis, title] of [
      ['X', axes.xLabel],
      ['Y', axes.yLabel],
    ]) {
      const full = plot.getByText(title, { exact: true }).filter({ visible: true });
      const label = await full.boundingBox();
      if (!label) throw new Error('The full axis title must be visible.');
      expect(label.x).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      expect(await graphic.getByText(axis, { exact: true }).isVisible()).toBe(true);
    }
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

test.each([
  'radar',
  'polar',
] as const)('keeps long %s labels and their values within a narrow chart card', async type => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    await page.goto(inject('browserFixtureUrl') + 'tests/fixtures/readerGraphics.html?long-radial');
    const plot = page.locator(`.type-${type}`);
    const graphic = plot.getByRole('img');
    await graphic.waitFor();
    const bounds = await graphic.boundingBox();
    if (!bounds) throw new Error('Radial chart must be visible.');
    const text = await labels(graphic, '.q-radial-label > tspan:visible');
    expect(text.length).toBeGreaterThan(0);
    expect(
      text.filter(label => label.left < bounds.x - 1 || label.right > bounds.x + bounds.width + 1)
    ).toEqual([]);
    const expected =
      type === 'radar'
        ? ['3 / 5 punti', '4 / 5 punti']
        : ['60 / 100 richieste', '40 / 100 richieste'];
    expect(await numberedKey(plot)).toEqual([
      { number: 2, text: expect.stringMatching(new RegExp(`^Eastern measure.*: ${expected[0]}$`)) },
      { number: 4, text: expect.stringMatching(new RegExp(`^Western measure.*: ${expected[1]}$`)) },
    ]);
    const numberedRays = await graphic.locator('.q-radial-label[data-in-key]').evaluateAll(rays =>
      rays.map(ray => ({
        name: ray.firstElementChild?.textContent,
        marker: ray.querySelector('.q-radial-marker')?.textContent,
      }))
    );
    expect(numberedRays).toEqual([
      { name: expect.stringMatching(/^Eastern measure/), marker: '2' },
      { name: expect.stringMatching(/^Western measure/), marker: '4' },
    ]);
  } finally {
    await page.close();
  }
});
