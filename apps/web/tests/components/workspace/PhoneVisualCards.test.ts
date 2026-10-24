import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { withMutedAudio } from '../../../../../scripts/browser-audio';
import viteConfig from '../../../vite.config';

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;
beforeAll(async () => {
  server = await createServer({
    ...viteConfig({ command: 'serve', mode: 'test' }),
    configFile: false,
    root: path.resolve('apps/web'),
    cacheDir: path.resolve('node_modules/.vite-phone-visual-cards'),
    optimizeDeps: { entries: ['tests/fixtures/phoneVisualCards.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  browser = await chromium.launch(withMutedAudio({ headless: true }));
  const warmup = await browser.newPage();
  try {
    await warmup.goto(`${baseUrl}tests/fixtures/phoneVisualCards.html?case=steps`);
    await warmup.locator('.scene-host h2').waitFor();
    await warmup.waitForFunction(iconsLoaded);
  } finally {
    await warmup.close();
  }
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

function iconsLoaded() {
  return [...document.querySelectorAll<HTMLElement>('.meaning-icon')].every(icon =>
    icon instanceof SVGElement
      ? icon.childElementCount > 0
      : decodeURIComponent(icon.style.getPropertyValue('--icon-url')).includes('/>')
  );
}

async function openCard(kind: string) {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await page.goto(`${baseUrl}tests/fixtures/phoneVisualCards.html?case=${kind}`);
  await page.locator('.scene-host').waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (['steps', 'comparison'].includes(kind)) {
    await page.locator('.motion-target').first().waitFor();
  }
  await page.waitForFunction(iconsLoaded);
  return page;
}
async function evidence(page: Page, name: string) {
  const directory = process.env.PHONE_VISUAL_EVIDENCE;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.waitForFunction(iconsLoaded);
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

test('1: an unresolved historical PDF reference yields its prepared scene after reload', async () => {
  const page = await openCard('missing');
  try {
    expect(await page.locator('.scene-host').innerText()).not.toContain('PDF_IMAGE');
    expect(await page.locator('.scene-host h2').textContent()).toBe('Una scena disponibile');
    await page.reload();
    await page.locator('.scene-host h2').waitFor();
    expect(await page.locator('.scene-host h2').textContent()).toBe('Una scena disponibile');
    await evidence(page, '01-immagine-assente');
  } finally {
    await page.close();
  }
});

test.each([
  'available',
  'broken',
])('1: resolves an %s image without exposing its placeholder', async imageState => {
  const page = await openCard(`missing&asset=${imageState}`);
  try {
    if (imageState === 'available') {
      await expect
        .poll(() =>
          page.locator('.scene-host img').evaluate((img: HTMLImageElement) => img.naturalWidth)
        )
        .toBe(180);
      expect(await page.locator('.scene-host img').getAttribute('alt')).toBe('Figura di esempio');
    } else {
      await page.locator('.scene-host h2').waitFor();
      expect(await page.locator('.scene-host h2').textContent()).toBe('Una scena disponibile');
    }
    expect(await page.locator('.scene-host').innerText()).not.toContain('PDF_IMAGE');
  } finally {
    await page.close();
  }
});

test('2: matrix scene cells render authored math through KaTeX', async () => {
  const page = await openCard('math');
  try {
    expect(await page.locator('.scene-host td .katex math').count()).toBe(4);
    expect(
      (await page.locator('.scene-host td .katex-html').allTextContents()).map(text =>
        text.replaceAll('\u200b', '')
      )
    ).toEqual(['x', 'ω11', 'h=Ωx', 'b']);
    await evidence(page, '02-formule-matrici');
  } finally {
    await page.close();
  }
});

test('1: a historical image-only preparation shows a bounded passage-derived card without image wording', async () => {
  const page = await openCard('missing&historical');
  try {
    const card = await page.locator('.scene-host').innerText();
    expect(
      (await page.locator('.scene-host blockquote').innerText()).replace(/^“\s*/u, '').trim()
    ).toBe('In una situazione ambigua, le persone osservano gli altri prima di intervenire.');
    expect(card).not.toContain('PDF_IMAGE');
    expect(card).not.toContain('Un esempio visivo');
    expect(card).not.toContain('Figura di esempio');
    expect(card).not.toContain('Una figura');
    await evidence(page, '01-immagine-assente');
  } finally {
    await page.close();
  }
});

test('3: step connectors join badge centers, ending at the next badge', async () => {
  const page = await openCard('steps');
  try {
    const geometry = await page.locator('.steps li').evaluateAll(rows =>
      rows.slice(0, -1).map((row, index) => {
        const style = getComputedStyle(row, '::before');
        const box = row.getBoundingClientRect();
        const badgeElement = row.querySelector('.step-index');
        const nextElement = rows[index + 1].querySelector('.step-index');
        if (!badgeElement || !nextElement) throw new Error('Both step badges must exist');
        const badge = badgeElement.getBoundingClientRect();
        const next = nextElement.getBoundingClientRect();
        const scale = box.width / (row as HTMLElement).offsetWidth;
        return {
          centerError:
            box.left + Number.parseFloat(style.left) * scale - (badge.left + badge.width / 2),
          endError:
            box.top +
            (Number.parseFloat(style.top) + Number.parseFloat(style.height)) * scale -
            next.top,
        };
      })
    );
    for (const row of geometry) {
      expect(Math.abs(row.centerError)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.endError)).toBeLessThanOrEqual(1);
    }
    await evidence(page, '03-collegamenti-passaggi');
  } finally {
    await page.close();
  }
});

test('4: verdict titles have the same icon spacing as their item rows', async () => {
  const page = await openCard('comparison');
  try {
    const gaps = await page.locator('.groups section').evaluateAll(groups =>
      groups.map(group => {
        const heading = group.querySelector('h3');
        const row = group.querySelector('li');
        if (!heading || !row) throw new Error('Group heading and row must exist');
        const gap = (element: Element) => {
          const text = element.querySelector('span:last-child');
          const icon = element.querySelector('.meaning-icon');
          if (!text || !icon) throw new Error('Icon and text must exist');
          return text.getBoundingClientRect().left - icon.getBoundingClientRect().right;
        };
        return { title: gap(heading), item: gap(row) };
      })
    );
    for (const gap of gaps) {
      expect(gap.title).toBeGreaterThan(0);
      expect(Math.abs(gap.title - gap.item)).toBeLessThanOrEqual(1);
    }
    await evidence(page, '04-spaziatura-confronto');
  } finally {
    await page.close();
  }
});

test('5: long bar labels remain fully inside the phone chart', async () => {
  const page = await openCard('bars');
  try {
    await page.locator('.data-chart svg').waitFor();
    const labels = await page
      .locator('.data-chart svg [aria-label="y-axis tick label"] text')
      .evaluateAll(nodes =>
        nodes.map(node => {
          const box = node.getBoundingClientRect();
          const svg = node.closest('svg');
          if (!svg) throw new Error('Chart label must belong to SVG');
          const chart = svg.getBoundingClientRect();
          const lines = [...node.querySelectorAll('tspan')];
          return {
            text: lines.length ? lines.map(line => line.textContent).join(' ') : node.textContent,
            left: box.left - chart.left,
            right: chart.right - box.right,
          };
        })
      );
    expect(labels.map(label => label.text?.replaceAll('\n', ' '))).toEqual([
      'Persona della maggioranza',
      'Persona percepita straniera',
    ]);
    for (const label of labels) {
      expect(label.left).toBeGreaterThanOrEqual(0);
      expect(label.right).toBeGreaterThanOrEqual(0);
    }
    await evidence(page, '05-etichette-grafico');
  } finally {
    await page.close();
  }
});

test.each([768, 1440])('retains complete scene fitting at %s px', async width => {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  try {
    for (const kind of ['missing', 'math', 'steps', 'comparison', 'bars']) {
      await page.goto(`${baseUrl}tests/fixtures/phoneVisualCards.html?case=${kind}`);
      await page.locator('.scene-host h2').waitFor();
      if (kind === 'bars') await page.locator('.data-chart svg').waitFor();
      const bounds = await page.locator('.scene-host').evaluate(async card => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const box = card.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      });
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.left).toBeGreaterThanOrEqual(-1);
      expect(bounds.right).toBeLessThanOrEqual(width + 1);
    }
  } finally {
    await page.close();
  }
});
