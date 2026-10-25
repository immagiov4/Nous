import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { withMutedAudio } from '../../../../../scripts/browser-audio';

let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  baseUrl = inject('browserFixtureUrl');
  browser = await chromium.launch(withMutedAudio({ headless: true }));
});

afterAll(async () => {
  await browser?.close();
});

const formulaViewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

test('keeps the save action at its approved size when a scene is fitted on desktop or touch screens', async () => {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  try {
    let reference: { width: number; height: number } | undefined;
    for (const viewport of formulaViewports) {
      await page.setViewportSize(viewport);
      await page.goto(
        `${baseUrl}tests/fixtures/playbackLayout.html?saveVisual=1&formulas=1&formulaPath=wide-scene`
      );
      const host = page.locator('.scene-host');
      await host.waitFor();
      await page.waitForFunction(
        () => !!document.querySelector('.scene-fit')?.getAttribute('style')
      );
      expect(await page.locator('.playback-visual-action button').count()).toBe(0);
      await host.hover();
      const button = page.locator('.playback-visual-action button');
      await button.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const size = await button.boundingBox();
      if (!size) throw new Error('Save action must be visible');
      const scale = await page
        .locator('.scene-fit')
        .evaluate(slot => Number((slot as HTMLElement).style.getPropertyValue('--scene-scale')));
      expect(scale).toBeLessThan(1);
      if (reference) {
        expect(size.width).toBeCloseTo(reference.width, 0);
        expect(size.height).toBeCloseTo(reference.height, 0);
      }
      reference = size;
      const center = await host.boundingBox();
      if (!center) throw new Error('Visual must be visible');
      expect(size.x + size.width / 2).toBeCloseTo(center.x + center.width / 2, 0);
      await evidence(page, `save-fitted-${viewport.width}`);
      await page.mouse.move(0, 0);
      await button.waitFor({ state: 'detached' });
    }
  } finally {
    await page.close();
  }
});
for (const viewport of formulaViewports) {
  test.each([
    'plain',
    'inline',
    'inherited',
    'cards',
    'aligned',
    'fallback',
    'scene',
    'wide-scene',
    'stored',
  ])(`uses the existing large formula geometry for %s at ${viewport.width}px`, async formulaPath => {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(
        `${baseUrl}tests/fixtures/playbackLayout.html?formulas=1&formulaPath=${formulaPath}`
      );
      const formula = page.locator('.scene-host .katex:not(.spotlight-symbol .katex)');
      await formula.waitFor();
      await page.waitForFunction(() =>
        document.querySelector('.scene-host')?.classList.contains('lesson-player-formula')
      );
      expect(await page.locator('.scene-host .katex-error').count()).toBe(0);
      expect(await page.locator('.scene-host').innerText()).not.toMatch(/\\(?:mathbf|omega)/);
      const size = await formula.evaluate(formula => {
        const actual = formula.getBoundingClientRect();
        const reference = formula.cloneNode(true) as HTMLElement;
        reference.style.fontSize = getComputedStyle(formula).getPropertyValue('--symbol-size');
        formula.after(reference);
        const expected = reference.getBoundingClientRect();
        reference.remove();
        return {
          width: actual.width,
          height: actual.height,
          expectedWidth: expected.width,
          expectedHeight: expected.height,
        };
      });
      expect(Math.round(size.width)).toBeGreaterThanOrEqual(Math.round(size.expectedWidth));
      expect(Math.round(size.height)).toBeGreaterThanOrEqual(Math.round(size.expectedHeight));
      const bounds = await formula.locator('.katex-html').evaluate(glyph => {
        const host = glyph.closest('.scene-host');
        if (!host) throw new Error('Formula must belong to the visual area');
        const actual = glyph.getBoundingClientRect();
        const available = host.getBoundingClientRect();
        return {
          left: actual.left,
          right: actual.right,
          hostLeft: available.left,
          hostRight: available.right,
        };
      });
      expect(Math.round(bounds.left)).toBeGreaterThanOrEqual(Math.round(bounds.hostLeft));
      expect(Math.round(bounds.right)).toBeLessThanOrEqual(Math.round(bounds.hostRight));
    } finally {
      await page.close();
    }
  });
}

test('retains the three-formula list and proportional explanation text', async () => {
  const page = await browser.newPage();
  try {
    for (const viewport of formulaViewports) {
      await page.setViewportSize(viewport);
      await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?formulas=3`);
      await page.locator('.type-parts .concept p').first().waitFor();
      expect(await page.locator('.scene-host .katex').count()).toBe(3);
      expect(await page.locator('.scene-host .type-parts .concept').count()).toBe(3);
      const fonts = await page
        .locator('.type-parts .concept p')
        .evaluateAll(paragraphs =>
          paragraphs.map(paragraph => getComputedStyle(paragraph).fontFamily)
        );
      expect(fonts.every(font => !font.includes('monospace'))).toBe(true);
    }
  } finally {
    await page.close();
  }
});

test('paints each new caption with its ready scene and retires the previous motion clock', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?boundary`);
    await page.locator('.scene-host > *').waitFor();
    for (let transition = 0; transition < 6; transition++) {
      const frames = await page.evaluate(
        () =>
          new Promise<boolean[]>(resolve => {
            const previousCaption = document.querySelector('.caption-page');
            const scenes: boolean[] = [];
            const observe = () => {
              if (document.querySelector('.caption-page') !== previousCaption)
                scenes.push(Boolean(document.querySelector('.scene-host')?.firstElementChild));
              if (scenes.length === 4) resolve(scenes);
              else requestAnimationFrame(observe);
            };
            requestAnimationFrame(observe);
            // Audio position updates arrive asynchronously, outside a discrete input event.
            setTimeout(() => dispatchEvent(new Event('playback-next')), 0);
          })
      );
      expect(frames).toEqual([true, true, true, true]);
    }
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

for (const type of ['flowchart', 'sequence', 'journey', 'bars']) {
  test(`keeps the nested ${type} drawing and caption position across equivalent snapshots`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?snapshot&type=${type}`);
      const drawing = page.locator('.scene .visual-content svg').first();
      await drawing.waitFor();
      const result = await page.evaluate(async () => {
        const graphic = document.querySelector('.scene .visual-content svg');
        const paragraph = document.querySelector<HTMLElement>('.caption-page');
        if (!graphic || !paragraph) throw new Error('Drawing and captions must exist');
        const scroll = paragraph.scrollTop;
        const host = document.querySelector('.scene-host');
        if (!host) throw new Error('Scene host must exist');
        const observer = new MutationObserver(() => {});
        observer.observe(host, {
          childList: true,
          subtree: true,
        });
        dispatchEvent(new Event('playback-snapshot'));
        for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
        const removed = observer.takeRecords().flatMap(record => [...record.removedNodes]);
        observer.disconnect();
        return {
          retained: document.querySelector('.scene .visual-content svg') === graphic,
          removed: removed.some(node => node === graphic || node.contains(graphic)),
          scrollBefore: scroll,
          scrollAfter: paragraph.scrollTop,
        };
      });
      expect(result.retained).toBe(true);
      expect(result.removed).toBe(false);
      expect(result.scrollBefore).toBeGreaterThan(0);
      expect(result.scrollAfter).toBe(result.scrollBefore);
      const original = await drawing.elementHandle();
      await page.evaluate(() => dispatchEvent(new Event('playback-scene-change')));
      await page.waitForFunction(
        () => document.querySelector('.scene h2')?.textContent === 'Nuovo contenuto'
      );
      await page.waitForFunction(element => !element?.isConnected, original);
      await drawing.waitFor();
      expect(await page.locator('.scene h2').textContent()).toBe('Nuovo contenuto');
    } finally {
      await page.close();
    }
  });
}

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

async function openOnset(mode = '') {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'no-preference',
  });
  await page.goto(`${baseUrl}tests/fixtures/playbackOnset.html?mode=${mode}`);
  return page;
}

test('finishes voice cue fades at word start while captions retain their 1.3 second lead', async () => {
  const page = await openOnset();
  try {
    await page.locator('[data-motion-id]').first().waitFor({ state: 'attached' });
    expect(
      await page.locator('.scene').evaluate(element => getComputedStyle(element).animationDuration)
    ).toBe('0.18s');
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
  } finally {
    await page.close();
  }
});

test.each(['path', 'formula'])('starts %s cues on the voice clock', async mode => {
  const page = await openOnset(mode);
  try {
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
      expect(state.transition?.split(',').some(duration => duration.trim() === '0.3s')).toBe(true);
    } else {
      expect(state.before.symbol).toBe(false);
      expect(state.symbol).toBe(true);
      expect(state.definitionVisible).toBe(true);
    }
  } finally {
    await page.close();
  }
});

test('selects sourced formula cards on the voice clock after forward and backward seeks', async () => {
  const page = await openOnset('cards');
  try {
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
  } finally {
    await page.close();
  }
});

test('keeps an unprepared passage empty beside its captions', async () => {
  const page = await openOnset('fallback');
  try {
    await page.locator('.scene-host').waitFor({ state: 'attached' });
    expect(await page.locator('.scene-host').textContent()).toBe('');
    expect(await page.locator('.scene-host').getAttribute('aria-hidden')).toBe('true');
    expect(await page.locator('.captions').textContent()).toContain('Uno');
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

function iconsLoaded() {
  return [...document.querySelectorAll<HTMLElement>('.meaning-icon')].every(icon =>
    icon instanceof SVGElement
      ? icon.childElementCount > 0
      : decodeURIComponent(icon.style.getPropertyValue('--icon-url')).includes('/>')
  );
}

async function openCard(kind: string) {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?case=${kind}`);
  await page.locator('.scene-host').waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  if (['steps', 'comparison'].includes(kind)) {
    await page.locator('.motion-target').first().waitFor();
  }
  await page.waitForFunction(iconsLoaded);
  return page;
}

for (const width of [412, 1440]) {
  for (const kind of ['prices', 'dense']) {
    test(`card followup: ${kind} at ${width}px`, async () => {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        reducedMotion: 'reduce',
      });
      try {
        await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?case=${kind}`);
        await page.locator('.scene-host h2').waitFor();
        await page.evaluate(() => document.fonts.ready);
        if (kind === 'prices') {
          expect(await page.locator('.scene-host h2').textContent()).toBe(
            '$5 today and $10 tomorrow'
          );
          expect(await page.locator('.scene-host').innerText()).toContain(
            'Budget: $15 now and $20 later.'
          );
          expect(await page.locator('.scene-host').innerText()).toContain(
            '$25 today and $30 tomorrow'
          );
          expect(await page.locator('.scene-host .katex math').count()).toBe(2);
        } else {
          await page.locator('.data-chart svg').waitFor();
          const labels = await page
            .locator('[aria-label="y-axis tick label"] text')
            .evaluateAll(nodes =>
              nodes.map(node => {
                const box = node.getBoundingClientRect();
                return {
                  text: [...node.querySelectorAll('tspan')].map(line => line.textContent).join(' '),
                  top: box.top,
                  bottom: box.bottom,
                };
              })
            );
          expect(labels.map(label => label.text)).toEqual(
            Array.from({ length: 6 }, (_, index) => `Persona del gruppo numero ${index + 1}`)
          );
          for (let index = 1; index < labels.length; index++) {
            expect(labels[index].top).toBeGreaterThan(labels[index - 1].bottom);
          }
        }
        await evidence(page, `${kind}-${width}`);
      } finally {
        await page.close();
      }
    });
  }
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

test('1: a historical image-only preparation stays empty while no replacement is available', async () => {
  const page = await openCard('missing&historical');
  try {
    const card = await page.locator('.scene-host').innerText();
    expect(card).toBe('');
    expect(await page.locator('.captions').textContent()).toContain('In una situazione ambigua');
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
      await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?case=${kind}`);
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

for (const width of [1440, 412]) {
  test(`decision options have no enclosing border at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?case=decision`);
      const options = page.locator('.decision .groups');
      await options.waitFor();
      expect(await options.locator('section').count()).toBe(2);
      expect(
        await options.evaluate(element => {
          const style = getComputedStyle(element);
          return [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ];
        })
      ).toEqual(['0px', '0px', '0px', '0px']);
      expect(await page.locator('.scene-intro').count()).toBe(0);
      expect(await page.locator('.decision-question').innerText()).toBe(
        'Le ragioni sostengono la conclusione?'
      );
    } finally {
      await page.close();
    }
  });
  test(`sequence lifelines end above the note at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?case=sequence`);
      await page.locator('.actor-line').first().waitFor({ state: 'attached' });
      const note = page.locator('.scene-note');
      expect(await note.innerText()).toBe('Le frecce descrivono un modello concettuale.');
      const geometry = await note.evaluate(async element => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const lines = Array.from(document.querySelectorAll<SVGLineElement>('.actor-line'));
        const messages = Array.from(
          document.querySelectorAll<SVGGraphicsElement>('.messageLine0, .messageLine1')
        );
        const messageBottomSvg = Math.max(
          ...messages.map(message => {
            const box = message.getBBox();
            return box.y + box.height;
          })
        );
        const graphic = document.querySelector('.mermaid-diagram > svg');
        if (!graphic) throw new Error('The sequence drawing must exist');
        return {
          background: getComputedStyle(element).backgroundColor,
          noteTop: element.getBoundingClientRect().top,
          svgBottom: graphic.getBoundingClientRect().bottom,
          lineBottoms: lines.map(line => line.getBoundingClientRect().bottom),
          tails: lines.map(line => line.y2.baseVal.value - messageBottomSvg),
          messageBottom: Math.max(
            ...messages.map(message => message.getBoundingClientRect().bottom)
          ),
        };
      });
      expect(geometry.background).toBe('rgb(251, 239, 233)');
      expect(geometry.lineBottoms).toHaveLength(3);
      for (const tail of geometry.tails) expect(tail).toBeCloseTo(20);
      expect(geometry.svgBottom).toBeLessThan(geometry.noteTop);
      for (const bottom of geometry.lineBottoms) {
        expect(bottom).toBeGreaterThan(geometry.messageBottom);
        expect(bottom).toBeLessThan(geometry.svgBottom);
        expect(bottom).toBeLessThan(geometry.noteTop);
      }
    } finally {
      await page.close();
    }
  });
}
test.each([false, true])('reader sequence notes are opaque (dark=%s)', async dark => {
  const page = await browser.newPage();
  try {
    await page.goto(
      `${baseUrl}tests/fixtures/playbackLayout.html?case=sequence&reader=1${dark ? '&dark=1' : ''}`
    );
    const note = page.locator('.scene-note');
    await note.waitFor();
    const background = await note.evaluate(element => {
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('A color sampling context is required');
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
    expect(background).toEqual(dark ? [71, 60, 50, 255] : [251, 239, 233, 255]);
  } finally {
    await page.close();
  }
});

test('centers both columns independently without caption jumps when visual height changes', async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?snapshot&type=parts`);
    await page.locator('.scene-host h2').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const measure = () =>
      page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error('Playback geometry must exist');
          const box = element.getBoundingClientRect();
          return { top: box.top, height: box.height, center: box.top + box.height / 2 };
        };
        return {
          stage: rect('.listening-stage'),
          captions: rect('.captions'),
          visual: rect('.scene-fit'),
        };
      });
    await page.waitForFunction(() => !!document.querySelector('.scene-fit')?.getAttribute('style'));
    const before = await measure();
    await page.evaluate(() => dispatchEvent(new Event('playback-short-scene')));
    await page.waitForFunction(height => {
      const current = document.querySelector('.scene-fit')?.getBoundingClientRect().height;
      return current !== undefined && Math.abs(current - height) > 1;
    }, before.visual.height);
    const after = await measure();
    for (const geometry of [before, after]) {
      expect(geometry.captions.center).toBeCloseTo(geometry.stage.center, 0);
      expect(geometry.visual.center).toBeCloseTo(geometry.stage.center, 0);
    }
    expect(after.captions.top).toBe(before.captions.top);
    expect(after.visual.height).toBeLessThan(before.visual.height);
    await evidence(page, 'centered-stable-columns-1080p');
  } finally {
    await page.close();
  }
});
