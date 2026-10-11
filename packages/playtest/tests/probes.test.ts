import { readFile } from 'node:fs/promises';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectSignals, installProbes } from '../src/probes/collect';
import type { ProbeSignal } from '../src/probes/pageProbes';
import { toFindings } from '../src/probes/thresholds';

const viewport = { width: 800, height: 600 };
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  page = await browser.newPage({ viewport });
  await installProbes(page);
});
afterEach(async () => {
  await page?.close();
});

async function fixture(name: string) {
  await page.setContent(
    await readFile(new URL(`./fixtures/pages/${name}.html`, import.meta.url), 'utf8')
  );
}

it('ignores text clipped to an empty painted rectangle by inset(50%) on an ancestor', async () => {
  await page.setContent(
    '<div style="clip-path:inset(50%)"><span style="display:inline-block;width:1px;overflow:hidden;white-space:nowrap">Screen reader only</span></div><span style="display:inline-block;width:20px;overflow:hidden;white-space:nowrap">Visible clipped text</span>'
  );
  const signals = await collectSignals(page);
  expect(signals).not.toContainEqual(
    expect.objectContaining({ kind: 'clipped-text', text: 'Screen reader only' })
  );
  expect(signals).toContainEqual(
    expect.objectContaining({ kind: 'clipped-text', text: 'Visible clipped text' })
  );
});

async function frames() {
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function metricsFixture(type: string) {
  await page.route('http://localhost/probe', async route =>
    route.fulfill({
      contentType: 'text/html',
      body: await readFile(new URL('./fixtures/pages/button.html', import.meta.url), 'utf8'),
    })
  );
  await page.goto('http://localhost/probe');
  await page.evaluate(type => {
    const metrics: {
      value?: number;
      hadRecentInput?: boolean;
      sources?: string[];
      durationMs: number;
      eventType: string;
    }[] = [];
    Object.assign(globalThis, { __testMetrics: metrics });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value?: number;
          hadRecentInput?: boolean;
          sources?: { node?: Node }[];
        };
        metrics.push({
          value: shift.value,
          hadRecentInput: shift.hadRecentInput,
          sources: shift.sources?.map(source => {
            const element =
              source.node instanceof Element ? source.node : source.node?.parentElement;
            return element?.id ? `#${element.id}` : '';
          }),
          durationMs: entry.duration,
          eventType: entry.name,
        });
      }
    }).observe({ type });
  }, type);
  await frames();
}

async function metric() {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __testMetrics: {
            value?: number;
            hadRecentInput?: boolean;
            sources?: string[];
            durationMs: number;
            eventType: string;
          }[];
        }
      ).__testMetrics[0]
  );
}

async function press(selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Missing fixture target: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  return box;
}

describe('deterministic page probes', () => {
  it('records raw widths only for visible clipped text', async () => {
    await fixture('text');
    const clipped = (await collectSignals(page)).filter(signal => signal.kind === 'clipped-text');
    expect(clipped).toHaveLength(1);
    expect(clipped[0]).toMatchObject({ selector: '#visible', clientWidth: 80 });
    expect(clipped[0].scrollWidth).toBeGreaterThan(clipped[0].clientWidth);
  });

  it('records overlap, horizontal overflow and computed contrast as facts', async () => {
    await fixture('text');
    const signals = await collectSignals(page);
    expect(signals).toContainEqual({
      kind: 'overlap',
      a: '#first',
      b: '#second',
      areaPx: 2500,
      covered: ['#first'],
      onTop: '#second',
    });
    expect(signals).toContainEqual({
      kind: 'horizontal-overflow',
      documentWidth: 1000,
      viewportWidth: 800,
    });
    expect(signals).toContainEqual({ kind: 'contrast', selector: '#visible', ratio: 21 });
  });

  it('drains facts and reports changed facts on later collections', async () => {
    await fixture('text');
    expect((await collectSignals(page)).length).toBeGreaterThan(0);
    expect(await collectSignals(page)).toEqual([]);
    await page.locator('#visible').evaluate(element => {
      element.textContent += ' More text';
    });
    expect(await collectSignals(page)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'clipped-text', selector: '#visible' }),
      ])
    );
  });

  it('records target movement when a changing label resizes a slider popover during drag', async () => {
    await fixture('slider');
    const box = await press('#slider');
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2);
    await frames();
    const signal = (await collectSignals(page)).find(
      signal => signal.kind === 'gesture-target-movement'
    );
    expect(signal).toMatchObject({ selector: '#slider', gesture: 'drag', animationActive: false });
    expect(signal?.kind === 'gesture-target-movement' && signal.maxDisplacementPx).toBeGreaterThan(
      0
    );
    expect(
      signal?.kind === 'gesture-target-movement' && signal.maxPointerOffsetChangePx
    ).toBeGreaterThan(0);
    expect(signal?.kind === 'gesture-target-movement' && signal.pointerTravelPx).toBe(10);
    await page.mouse.up();
  });

  it('records displacement but no offset change for a slider thumb following the pointer', async () => {
    await fixture('following-slider');
    const box = await press('#thumb');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x + 60, y);
    await frames();
    await page.mouse.move(x + 30, y);
    await frames();
    await page.mouse.up();
    const signal = (await collectSignals(page)).find(
      signal => signal.kind === 'gesture-target-movement'
    );
    expect(signal).toMatchObject({
      selector: '#thumb',
      gesture: 'drag',
      maxDisplacementPx: 60,
      pointerTravelPx: 90,
    });
    expect(
      signal?.kind === 'gesture-target-movement' && signal.maxPointerOffsetChangePx
    ).toBeCloseTo(0);
    expect(toFindings(signal ? [signal] : [], { pointerOffsetChangePx: 0 })).toEqual([]);
  });

  it('drains a page with 2,000 overlapping decorative divs without decorative overlap signals', async () => {
    const decorationCount = 2000;
    await page.setContent(
      `<style>.decoration { position: absolute; left: 100px; top: 100px; width: 100px; height: 100px; }</style>${'<div class="decoration"></div>'.repeat(decorationCount)}`
    );
    expect(await page.locator('.decoration').count()).toBe(decorationCount);
    expect((await collectSignals(page)).filter(signal => signal.kind === 'overlap')).toEqual([]);
    expect(await collectSignals(page)).toEqual([]);
  });

  it('records coverage when an interactive target overlaps a decorative layer', async () => {
    await fixture('text');
    await page.locator('#first').evaluate(element => {
      element.textContent = '';
      element.setAttribute('role', 'button');
    });
    await page.locator('#second').evaluate(element => {
      element.textContent = '';
    });
    const signals = await collectSignals(page);
    expect(signals.filter(signal => signal.kind === 'overlap')).toEqual([
      {
        kind: 'overlap',
        a: '#first',
        b: '#second',
        areaPx: 2500,
        covered: ['#first'],
        onTop: '#second',
      },
    ]);
    await page.locator('#first').evaluate(element => {
      (element as HTMLElement).style.zIndex = '1';
    });
    expect((await collectSignals(page)).filter(signal => signal.kind === 'overlap')).toEqual([
      {
        kind: 'overlap',
        a: '#first',
        b: '#second',
        areaPx: 2500,
        covered: ['#second'],
        onTop: '#first',
      },
    ]);
  });

  it.each([
    false,
    true,
  ])('records generic button movement with animationActive=%s', async animated => {
    await fixture('button');
    if (animated)
      await page.locator('#button').evaluate(element => element.classList.add('animated'));
    await press('#button');
    await frames();
    const signal = (await collectSignals(page)).find(
      signal => signal.kind === 'gesture-target-movement'
    );
    expect(signal).toMatchObject({
      selector: '#button',
      gesture: 'press',
      animationActive: animated,
    });
    expect(signal?.kind === 'gesture-target-movement' && signal.maxDisplacementPx).toBeGreaterThan(
      0
    );
    expect(
      signal?.kind === 'gesture-target-movement' && signal.maxPointerOffsetChangePx
    ).toBeGreaterThan(0);
    expect(signal?.kind === 'gesture-target-movement' && signal.pointerTravelPx).toBe(0);
    await page.mouse.up();
  });

  it('captures console errors and uncaught page errors, then drains them', async () => {
    await page.evaluate(() => console.error('console fixture error'));
    const error = page.waitForEvent('pageerror');
    await page.evaluate(() =>
      setTimeout(() => {
        throw new Error('uncaught fixture error');
      }, 0)
    );
    await error;
    expect(await collectSignals(page)).toEqual(
      expect.arrayContaining([
        { kind: 'console-error', message: 'console fixture error' },
        { kind: 'console-error', message: 'uncaught fixture error' },
      ])
    );
    expect(await collectSignals(page)).toEqual([]);
  });

  it('preserves the browser layout-shift score, sources and recent-input flag', async () => {
    await metricsFixture('layout-shift');
    await collectSignals(page);
    await press('#button');
    await frames();
    await page.mouse.up();
    await expect.poll(metric).toBeDefined();
    const expected = await metric();
    const recorded: ProbeSignal[] = [];
    await expect
      .poll(async () => {
        recorded.push(...(await collectSignals(page)));
        return recorded.find(signal => signal.kind === 'layout-shift');
      })
      .toMatchObject({
        kind: 'layout-shift',
        value: expected.value,
        hadRecentInput: expected.hadRecentInput,
        sources: expected.sources,
      });
    expect(expected.hadRecentInput).toBe(true);
    await page.mouse.up();
  });

  it('preserves Event Timing duration, event name and target', async () => {
    await metricsFixture('event');
    const busyDurationMs = 180;
    await page.locator('#button').evaluate((element, durationMs) => {
      element.addEventListener('pointerdown', () => {
        const end = performance.now() + durationMs;
        while (performance.now() < end) {
          /* Deliberate blocking work exercises Event Timing. */
        }
      });
    }, busyDurationMs);
    await press('#button');
    await frames();
    await page.mouse.up();
    await expect.poll(metric).toBeDefined();
    const expected = await metric();
    const recorded: ProbeSignal[] = [];
    await expect
      .poll(async () => {
        recorded.push(...(await collectSignals(page)));
        return recorded.find(
          signal => signal.kind === 'interaction-latency' && signal.eventType === 'pointerdown'
        );
      })
      .toEqual({
        kind: 'interaction-latency',
        durationMs: expected.durationMs,
        eventType: expected.eventType,
        target: '#button',
      });
    await page.mouse.up();
  });

  it('keeps visually visible aria-hidden text and excludes ancestor-clipped text', async () => {
    await fixture('text');
    await page.locator('#visible').evaluate(element => element.setAttribute('aria-hidden', 'true'));
    await page.locator('#outside').evaluate(element => {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:absolute;top:250px;width:100px;height:20px;overflow:hidden';
      element.before(wrapper);
      wrapper.append(element);
      (element as HTMLElement).style.top = '100px';
    });
    expect(
      (await collectSignals(page))
        .filter(signal => signal.kind === 'clipped-text')
        .map(signal => signal.selector)
    ).toEqual(['#visible']);
  });

  it('records alpha-composited contrast and leaves image backgrounds unmeasured', async () => {
    await fixture('text');
    await page.locator('#visible').evaluate(element => {
      (element as HTMLElement).style.color = 'rgba(0,0,0,0.5)';
    });
    const contrast = (await collectSignals(page)).find(
      signal => signal.kind === 'contrast' && signal.selector === '#visible'
    );
    expect(contrast?.kind === 'contrast' && contrast.ratio).toBeCloseTo(3.9767, 3);
    await page.locator('#visible').evaluate(element => {
      (element as HTMLElement).style.backgroundImage = 'linear-gradient(white, black)';
    });
    expect(
      (await collectSignals(page)).filter(
        signal => signal.kind === 'contrast' && signal.selector === '#visible'
      )
    ).toEqual([]);
  });

  it('retains maximum movement across return to origin and ends tracking at release', async () => {
    await fixture('button');
    await press('#button');
    await frames();
    await page.locator('#button').evaluate(element => element.classList.remove('moved'));
    await frames();
    await page.mouse.up();
    expect(await collectSignals(page)).toEqual(
      expect.arrayContaining([
        {
          kind: 'gesture-target-movement',
          selector: '#button',
          maxDisplacementPx: 80,
          maxPointerOffsetChangePx: 80,
          pointerTravelPx: 0,
          gesture: 'press',
          animationActive: false,
        },
      ])
    );
    await page.locator('#button').evaluate(element => element.classList.add('moved'));
    expect(
      (await collectSignals(page)).filter(signal => signal.kind === 'gesture-target-movement')
    ).toEqual([]);
  });

  it('installs once and reinstalls across navigation', async () => {
    await installProbes(page);
    await page.goto(
      'data:text/html,<div id="text" style="width:20px;white-space:nowrap;overflow:hidden">Long visible text</div>'
    );
    expect(
      (await collectSignals(page)).filter(signal => signal.kind === 'clipped-text')
    ).toHaveLength(1);
    await page.evaluate(() => console.error('once'));
    expect((await collectSignals(page)).filter(signal => signal.kind === 'console-error')).toEqual([
      { kind: 'console-error', message: 'once' },
    ]);
  });
});

describe('threshold conversion', () => {
  const movement: ProbeSignal = {
    kind: 'gesture-target-movement',
    selector: '#button',
    maxDisplacementPx: 80,
    maxPointerOffsetChangePx: 40,
    pointerTravelPx: 0,
    gesture: 'press',
    animationActive: true,
  };
  const signals: ProbeSignal[] = [
    { kind: 'clipped-text', selector: '#text', text: 'text', scrollWidth: 120, clientWidth: 80 },
    { kind: 'overlap', a: '#a', b: '#b', areaPx: 30, covered: ['#a'], onTop: '#b' },
    { kind: 'horizontal-overflow', documentWidth: 1000, viewportWidth: 800 },
    { kind: 'layout-shift', value: 0.2, sources: ['#text'], hadRecentInput: true },
    movement,
    { kind: 'interaction-latency', durationMs: 160, eventType: 'click', target: '#button' },
    { kind: 'contrast', selector: '#text', ratio: 2 },
    { kind: 'console-error', message: 'error' },
  ];

  it('raises no findings with unset thresholds for any signal kind', () => {
    expect(toFindings(signals, {})).toEqual([]);
  });
  it('uses only explicit thresholds and preserves gesture context', () => {
    expect(toFindings(signals, { pointerOffsetChangePx: 1 })).toEqual([
      { signal: movement, threshold: 1, taxonomyClass: 'D10' },
    ]);
    expect(toFindings([movement], { pointerOffsetChangePx: 40 })).toEqual([]);
  });
  it('maps configured measurements to reporting classes, including low contrast', () => {
    const findings = toFindings(signals, {
      clippedTextMinOverflowPx: 0,
      overlapMinAreaPx: 0,
      layoutShiftScore: 0,
      pointerOffsetChangePx: 0,
      interactionLatencyMs: 0,
      minContrastRatio: 3,
    });
    expect(findings.map(finding => finding.taxonomyClass)).toEqual([
      'D01',
      'D02',
      'D11',
      'D10',
      'D12',
      'D05',
    ]);
  });
});

it.each([
  'remove',
  'hide',
])('retains Event Timing when a slow click handler makes its target %s', async change => {
  await page.setContent('<button id="slow">Slow</button>');
  await page.locator('#slow').evaluate((element, change) => {
    element.addEventListener('click', () => {
      const start = performance.now();
      while (performance.now() - start < 150) {
        /* exceed the browser Event Timing reporting floor */
      }
      if (change === 'remove') element.remove();
      else (element as HTMLElement).style.display = 'none';
    });
  }, change);
  await page.locator('#slow').click();
  const signals: ProbeSignal[] = [];
  await expect
    .poll(async () => {
      signals.push(...(await collectSignals(page)));
      return signals.find(
        signal => signal.kind === 'interaction-latency' && signal.eventType === 'click'
      );
    })
    .toMatchObject({
      kind: 'interaction-latency',
      eventType: 'click',
      target: '#slow',
      durationMs: expect.any(Number),
    });
});
