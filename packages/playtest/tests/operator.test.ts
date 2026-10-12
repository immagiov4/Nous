import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SCREENSHOT_PRIVACY_MASK } from '../src/operator/observe';
import {
  type Observation,
  type OperatorSession,
  openOperatorSession,
} from '../src/operator/session';

const credentials = { email: 'operator-secret@example.test', password: 'secret-password-operator' };
let browser: Browser;
let session: OperatorSession;
let sessionClosed = true;
let runDir: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
});
afterAll(async () => {
  await browser?.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!sessionClosed) await session.close();
  sessionClosed = true;
  if (runDir) await rm(runDir, { recursive: true, force: true });
});

async function fixture(html: string, viewport: 'desktop' | 'mobile' = 'desktop'): Promise<Page> {
  runDir = await mkdtemp(join(tmpdir(), 'playtest-operator-'));
  session = await openOperatorSession({
    browser,
    locale: 'it-IT',
    baseUrl: `data:text/html,${encodeURIComponent(html)}`,
    viewport,
    credentials,
    runDir,
  });
  sessionClosed = false;
  const page = browser.contexts().at(-1)?.pages()[0];
  assert(page, 'The operator context must own a page');
  return page;
}

function ref(observation: Observation, name: string): string {
  const node = observation.nodes.find(node => node.name === name);
  if (!node) throw new Error(`Missing fixture node: ${name}`);
  return node.ref;
}

describe('operator', () => {
  it('keeps static editable fields and privacy masks from invalidating a capture', async () => {
    const page = await fixture(
      '<input type="email"><input type="password"><textarea></textarea><p style="pointer-events:none">Hint</p><button>Continue</button>'
    );
    const screenshot = vi.spyOn(page, 'screenshot');
    const observation = await session.observe();
    expect(observation.diagnostics).toBeUndefined();
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(observation.nodes.map(node => node.name)).toContain('Hint');
  });
  it.each([
    'once',
    'always',
  ] as const)('recaptures same-document mutations %s and diagnoses continued instability', async frequency => {
    const page = await fixture(
      '<button>Before mutation</button><span style="display:inline-block;width:20px;white-space:nowrap;overflow:hidden">Before clipped label</span>'
    );
    const screenshot = page.screenshot.bind(page);
    let captures = 0;
    vi.spyOn(page, 'screenshot').mockImplementation(async options => {
      if (captures++ === 0 || frequency === 'always') {
        await page.evaluate(count => {
          const button = document.querySelector('button');
          const span = document.querySelector('span');
          if (!button || !span) throw new Error('Capture fixture must contain button and span');
          button.textContent = `Changed ${count}`;
          span.textContent = `Clipped label ${count}`;
        }, captures);
      }
      return screenshot(options);
    });
    const observation = await session.observe();
    expect(page.screenshot).toHaveBeenCalledTimes(2);
    expect(observation.nodes.some(node => node.name === 'Changed 1')).toBe(true);
    expect(observation.diagnostics?.capture.unstable).toBe(
      frequency === 'always' ? true : undefined
    );
    const signals = await session.signals();
    expect(signals.filter(signal => signal.kind === 'clipped-text')).toEqual([
      expect.objectContaining({
        text: frequency === 'always' ? 'Clipped label 2' : 'Clipped label 1',
      }),
    ]);
  });

  it.each([
    'desktop',
    'mobile',
  ] as const)('references and activates a partly visible, partly covered control on %s', async viewport => {
    const page = await fixture(
      '<button style="position:fixed;left:-180px;top:100px;width:200px;height:40px" onclick="this.dataset.clicked=true">Partly visible</button><div style="position:fixed;left:5px;top:100px;width:15px;height:40px;background:white"></div>',
      viewport
    );
    const observation = await session.observe();
    const button = observation.nodes.find(node => node.role === 'button');
    assert(button?.point, 'Partly visible control must have an uncovered point');
    expect(button.point.x).toBeGreaterThan(0);
    expect(button.point.x).toBeLessThan(5);
    expect((await session.act({ type: 'click', ref: button.ref })).status).toBe('ok');
    expect(await page.locator('button').getAttribute('data-clicked')).toBe('true');
  });
  it('reobserves when post-action document acquisition loses its execution context', async () => {
    const page = await fixture('<button>Continue</button>');
    const observation = await session.observe();
    const evaluateHandle = page.evaluateHandle.bind(page);
    const acquisition = vi
      .spyOn(page, 'evaluateHandle')
      .mockImplementationOnce((...args) => evaluateHandle(...args))
      .mockImplementationOnce(async () => {
        await page.goto('data:text/html,<main>New document</main>');
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      });
    const result = await session.act({ type: 'click', ref: ref(observation, 'Continue') });
    expect(result.status).toBe('ok');
    expect(result.observation.nodes.map(node => node.name)).toContain('New document');
    expect(result.observation.stepIndex).toBe(1);
    // Target resolution plus two acquisition attempts: no input is dispatched twice.
    expect(acquisition).toHaveBeenCalledTimes(3);
  });

  it.each([
    'desktop',
    'mobile',
  ] as const)('returns the new document after a navigating link click on %s', async viewport => {
    const page = await fixture('<a href="https://operator.test/next">Continue</a>', viewport);
    await page.route('https://operator.test/next', route =>
      route.fulfill({ contentType: 'text/html', body: '<main>New document</main>' })
    );
    const observation = await session.observe();
    const result = await session.act({ type: 'click', ref: ref(observation, 'Continue') });
    expect(result.status).toBe('ok');
    expect(result.observation.url).toBe('https://operator.test/next');
    expect(result.observation.nodes.map(node => node.name)).toContain('New document');
  });

  it.each([
    'desktop',
    'mobile',
  ] as const)('returns the new document after a button navigates from a microtask on %s', async viewport => {
    const page = await fixture(
      `<button onclick="queueMicrotask(() => location.href = 'https://operator.test/next')">Continue</button>`,
      viewport
    );
    await page.route('https://operator.test/next', route =>
      route.fulfill({ contentType: 'text/html', body: '<main>New document</main>' })
    );
    const observation = await session.observe();
    const result = await session.act({ type: 'click', ref: ref(observation, 'Continue') });
    expect(result.status).toBe('ok');
    expect(result.observation.url).toBe('https://operator.test/next');
    expect(result.observation.nodes.map(node => node.name)).toContain('New document');
  });

  it('counts repeated navigation invalidations against the approved capture retry budget', async () => {
    const page = await fixture('<p>Initial document</p>');
    const screenshot = page.screenshot.bind(page);
    let count = 0;
    const capture = vi.spyOn(page, 'screenshot').mockImplementation(async options => {
      const image = await screenshot(options);
      await page.goto(`data:text/html,<p>Document ${++count}</p>`);
      return image;
    });
    await expect(session.observe()).rejects.toThrow('Document changed during capture');
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('reads non-interactive painted text and still withholds covered text', async () => {
    await fixture(
      '<p style="pointer-events:none">Visible hint</p><div style="position:relative"><p style="pointer-events:none">Covered hint</p><div style="position:absolute;inset:0;background:white"></div></div>'
    );
    const observation = await session.observe();
    expect(observation.nodes.map(node => node.name)).toContain('Visible hint');
    expect(JSON.stringify(observation.nodes)).not.toContain('Covered hint');
  });

  it('keeps ordinary message fields visible while masking credential-bearing controls', async () => {
    const page = await fixture(
      '<label>Message<textarea>Ordinary question</textarea></label><div contenteditable>Editable note</div><input value="' +
        credentials.password +
        '"><input type="password" value="' +
        credentials.password +
        '">'
    );
    const observation = await session.observe();
    const image = await readFile(observation.screenshotPath);
    expect(
      image.equals(
        await page.screenshot({
          mask: [page.locator('input')],
          maskColor: SCREENSHOT_PRIVACY_MASK.color,
        })
      )
    ).toBe(true);
    expect(observation.nodes.map(node => node.name)).toContain('Editable note');
    expect(JSON.stringify(observation.nodes)).not.toContain(credentials.password);
  });

  it('rejects credentials in ordinary fields and mismatched login fields', async () => {
    const page = await fixture(
      '<label>Message<textarea></textarea></label><label>Email<input type="email"></label><label>Password<input type="password"></label>'
    );
    const observation = await session.observe();
    for (const [name, field] of [
      ['Message', 'password'],
      ['Message', 'email'],
      ['Email', 'password'],
      ['Password', 'email'],
    ] as const) {
      expect(
        (await session.act({ type: 'fill-credential', ref: ref(observation, name), field })).status
      ).toBe('not-actionable');
    }
    expect(await page.locator('textarea').inputValue()).toBe('');
    expect(await page.locator('input[type=email]').inputValue()).toBe('');
  });

  it('redacts form-encoded credentials containing spaces from observed URLs', async () => {
    const page = await fixture('<p>Public page</p>');
    // Supply a secret with spaces at the operator boundary, independent of native form filling.
    const { observePage } = await import('../src/operator/observe');
    vi.spyOn(page, 'url').mockReturnValue('https://example.test/?password=a+b&email=a%2Bb');
    const observation = await observePage({
      page,
      stepIndex: 0,
      screenshotPath: join(runDir, 'encoded.png'),
      secrets: ['a b', 'a+b'],
    });
    expect(observation.url).toBe('https://example.test/?password=[redacted]&email=[redacted]');
  });
  it.each([1, 2])('retries a failed screenshot once (%i injected failures)', async failures => {
    const page = await fixture('<main>Visible capture</main>');
    const original = page.screenshot.bind(page);
    let attempts = 0;
    const screenshot = vi.spyOn(page, 'screenshot').mockImplementation(options => {
      attempts++;
      if (attempts <= failures) return Promise.reject(new Error('Synthetic capture failure'));
      return original(options);
    });
    if (failures === 1) {
      const observation = await session.observe();
      expect(observation.stepIndex).toBe(0);
      expect(observation.nodes.map(node => node.name)).toContain('Visible capture');
      expect((await readFile(observation.screenshotPath)).length).toBeGreaterThan(0);
    } else {
      await expect(session.observe()).rejects.toThrow('Synthetic capture failure');
    }
    expect(screenshot).toHaveBeenCalledTimes(2);
  });
  it('excludes covered and offscreen descendants from a visible control name', async () => {
    await fixture(`<button style="position:relative;width:400px;height:100px">
      Visible control
      <span style="position:absolute;left:0;top:0">Covered descendant</span>
      <span style="position:absolute;left:0;top:0;width:160px;height:25px;background:white"></span>
      <span style="position:absolute;top:1500px">Offscreen descendant</span>
    </button>`);
    const observation = await session.observe();
    expect(observation.nodes.map(node => node.name)).toContain('Visible control');
    expect(JSON.stringify(observation)).not.toContain('Covered descendant');
    expect(JSON.stringify(observation)).not.toContain('Offscreen descendant');
  });

  it('withholds hidden accessibility labels and text clipped by an ancestor', async () => {
    await fixture(`<span id="hidden" style="display:none">Hidden accessible name</span>
      <button aria-labelledby="hidden">Visible name</button>
      <div style="height:20px;overflow:hidden"><p style="margin-top:100px">Clipped descendant</p></div>
      <div style="opacity:0">Transparent text</div>`);
    const observation = await session.observe();
    expect(observation.nodes.map(node => node.name)).toContain('Visible name');
    for (const hidden of ['Hidden accessible name', 'Clipped descendant', 'Transparent text']) {
      expect(JSON.stringify(observation)).not.toContain(hidden);
    }
  });

  it('redacts generated credentials from raw probe text', async () => {
    await fixture(
      `<p style="width:60px;overflow:hidden;white-space:nowrap">Account ${credentials.email}</p>`
    );
    await session.observe();
    const signals = await session.signals();
    expect(signals.some(signal => signal.kind === 'clipped-text')).toBe(true);
    expect(JSON.stringify(signals)).not.toContain(credentials.email);
  });

  it('masks credentials split across nested elements before extracting text', async () => {
    const split = Math.floor(credentials.email.length / 2);
    const page = await fixture(
      `<p id="split"><span>${credentials.email.slice(0, split)}</span><span>${credentials.email.slice(split)}</span></p><p>Public content</p>`
    );
    const observation = await session.observe();
    expect(observation.nodes.map(node => node.name)).toEqual(['Public content']);
    const screenshot = await readFile(observation.screenshotPath);
    expect(screenshot.equals(await page.screenshot({ mask: [page.locator('#split')] }))).toBe(true);
  });

  it('does not reuse refs when a new document has already been observed', async () => {
    const page = await fixture('<button>Original</button>');
    const original = ref(await session.observe(), 'Original');
    await page.goto('data:text/html,<button>Replacement</button>');
    const replacement = ref(await session.observe(), 'Replacement');
    expect(replacement).not.toBe(original);
    expect((await session.act({ type: 'click', ref: original })).status).toBe('stale-reference');
    expect((await session.act({ type: 'click', ref: 'unknown-reference' })).status).toBe(
      'stale-reference'
    );
  });

  it('can act on a fresh observation of the same element after detaching and reinserting it', async () => {
    const page = await fixture('<button onclick="this.textContent=\'Clicked\'">Original</button>');
    const original = ref(await session.observe(), 'Original');
    const element = await page.locator('button').elementHandle();
    assert(element);
    try {
      await element.evaluate(element => element.remove());
      expect((await session.act({ type: 'click', ref: original })).status).toBe('stale-reference');
      await element.evaluate(element => document.body.append(element));
      const current = ref(await session.observe(), 'Original');
      const result = await session.act({ type: 'click', ref: current });
      expect(result.status).toBe('ok');
      expect(result.observation.nodes.map(node => node.name)).toContain('Clicked');
    } finally {
      await element.dispose();
    }
  });

  it('excludes covered text, including text inside an otherwise visible container', async () => {
    await fixture(`<style>
      #covered { position:fixed; left:20px; top:20px; width:200px; height:40px }
      #cover { position:fixed; left:20px; top:20px; width:200px; height:40px; background:white; z-index:1 }
    </style><div id="covered">Covered secret text</div><div id="cover">Floating control</div>
    <div style="position:absolute;top:100px">Visible text<span style="display:none">Hidden descendant</span></div>`);
    const observation = await session.observe();
    expect(observation.nodes.map(node => node.name)).toContain('Visible text');
    expect(JSON.stringify(observation)).not.toContain('Covered secret text');
    expect(decodeURIComponent(observation.url)).not.toContain('Covered secret text');
    expect(JSON.stringify(observation)).not.toContain('Hidden descendant');
    expect(observation.nodes.map(node => node.name)).toContain('Floating control');
    expect((await readFile(observation.screenshotPath)).subarray(1, 4).toString()).toBe('PNG');
  });

  it('reveals below-fold text only after scrolling down', async () => {
    const page = await fixture(
      '<div>At top</div><button style="position:absolute;top:1000px">Below fold</button><div style="height:1800px"></div>'
    );
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
    const before = await session.observe();
    expect(before.stepIndex).toBe(0);
    expect(JSON.stringify(before)).not.toContain('Below fold');
    const result = await session.act({ type: 'scroll', direction: 'down' });
    expect(result.status).toBe('ok');
    expect(result.observation.nodes.map(node => node.name)).toContain('Below fold');
    expect(result.observation.stepIndex).toBe(before.stepIndex + 1);
    const up = await session.act({ type: 'scroll', direction: 'up' });
    expect(up.status).toBe('ok');
    expect(JSON.stringify(up.observation)).not.toContain('Below fold');
    expect(up.observation.nodes.map(node => node.name)).toContain('At top');
  });

  it.each([
    'replace',
    'navigate',
    'reload',
  ] as const)('returns stale-reference after %s', async change => {
    const page = await fixture('<button>Original</button>');
    const original = ref(await session.observe(), 'Original');
    if (change === 'replace')
      await page.locator('button').evaluate(element => {
        element.outerHTML = '<button>Replacement</button>';
      });
    if (change === 'navigate') await page.goto('data:text/html,<button>Replacement</button>');
    if (change === 'reload') await page.reload();
    expect(await session.act({ type: 'click', ref: original })).toMatchObject({
      status: 'stale-reference',
      observation: { nodes: expect.any(Array) },
    });
  });

  it('fills credentials privately and redacts reflected credentials and URLs', async () => {
    const page = await fixture(
      '<label>Email<input type="email"></label><label>Password<input type="password"></label><p id="reflection"></p>'
    );
    const email = await session.act({
      type: 'fill-credential',
      ref: ref(await session.observe(), 'Email'),
      field: 'email',
    });
    expect(await page.locator('input[type=email]').inputValue()).toBe(credentials.email);
    const password = await session.act({
      type: 'fill-credential',
      ref: ref(email.observation, 'Password'),
      field: 'password',
    });
    expect(await page.locator('input[type=password]').inputValue()).toBe(credentials.password);
    await page.locator('#reflection').evaluate((element, secrets) => {
      element.textContent = `${secrets.email} ${secrets.password}`;
    }, credentials);
    const observation = await session.observe();
    for (const observed of [email.observation, password.observation, observation]) {
      expect(JSON.stringify(observed)).not.toContain(credentials.email);
      expect(JSON.stringify(observed)).not.toContain(credentials.password);
    }
    // Compare pixels against an explicit mask, not merely against a changed screenshot.
    const redacted = await readFile(observation.screenshotPath);
    const expectedScreenshot = await page.screenshot({
      mask: [page.locator('input'), page.locator('#reflection')],
    });
    expect(redacted.equals(expectedScreenshot)).toBe(true);
    await page.goto(`data:text/html,${encodeURIComponent(`<p>${credentials.email}</p>`)}`);
    const secretUrl = await session.observe();
    expect(secretUrl.url).not.toContain(credentials.email);
    expect(secretUrl.url).not.toContain(encodeURIComponent(credentials.email));
  });

  it('executes verbatim typing, keyboard, click and drag; collects raw signals', async () => {
    const page = await fixture(
      '<label>Message<textarea></textarea></label><button onclick="this.textContent=\'Clicked\'">Send</button><div role="slider" style="width:200px;height:30px;background:gray">Drag</div>'
    );
    const message = 'A literal message: <b>hello</b>\nsecond line';
    await page.locator('textarea').evaluate(element => {
      element.addEventListener('keydown', event => {
        element.setAttribute('data-last-key', (event as KeyboardEvent).key);
      });
    });
    const typed = await session.act({
      type: 'type',
      ref: ref(await session.observe(), 'Message'),
      text: message,
    });
    expect(typed.status).toBe('ok');
    expect(await page.locator('textarea').inputValue()).toBe(message);
    expect(await page.locator('textarea').getAttribute('data-last-key')).toBe('e');
    expect((await session.act({ type: 'press', key: 'Tab' })).status).toBe('ok');
    const clicked = await session.act({
      type: 'click',
      ref: ref(await session.observe(), 'Send'),
    });
    expect(clicked.observation.nodes.map(node => node.name)).toContain('Clicked');
    expect(
      (await session.act({ type: 'drag', ref: ref(clicked.observation, 'Drag'), dx: 30, dy: 0 }))
        .status
    ).toBe('ok');
    await page.evaluate(() => console.error('generic fact'));
    expect(await session.signals()).toContainEqual({
      kind: 'console-error',
      message: 'generic fact',
    });
    expect(await session.signals()).toEqual([]);
  });

  it('returns not-actionable for a target covered after observation and for disabled input', async () => {
    const page = await fixture('<button>Target</button><label>Disabled<input disabled></label>');
    const observation = await session.observe();
    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;inset:0;background:white';
      document.body.append(cover);
    });
    expect((await session.act({ type: 'click', ref: ref(observation, 'Target') })).status).toBe(
      'target-moved'
    );
    await page.locator('body > div').evaluate(element => element.remove());
    expect(
      (
        await session.act({
          type: 'type',
          ref: ref(await session.observe(), 'Disabled'),
          text: 'text',
        })
      ).status
    ).toBe('not-actionable');
  });

  it.each([
    'click',
    'drag',
  ] as const)('keeps the observed point when a control moves before %s', async type => {
    const page = await fixture(
      '<button style="position:absolute;left:20px;top:20px" onclick="this.dataset.clicked=\'yes\'">Moving</button>'
    );
    const before = await session.observe();
    const node = before.nodes.find(node => node.name === 'Moving');
    assert(node);
    await page.locator('button').evaluate(element => {
      (element as HTMLElement).style.left = '300px';
    });
    const result = await session.act(
      type === 'click' ? { type, ref: node.ref } : { type, ref: node.ref, dx: 30, dy: 0 }
    );
    expect(result).toMatchObject({
      status: 'target-moved',
      observedBox: node.box,
      currentBox: { ...node.box, x: 300 },
    });
    expect(await page.locator('button').getAttribute('data-clicked')).toBeNull();
    expect(
      (await session.act({ type: 'click', ref: ref(result.observation, 'Moving') })).status
    ).toBe('ok');
    expect(await page.locator('button').getAttribute('data-clicked')).toBe('yes');
  });

  it('uses a touch pointer on mobile and refuses mouse-based selection drag', async () => {
    const page = await fixture(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><button onpointerdown="this.dataset.pointer=event.pointerType" onclick="this.dataset.clicked=\'yes\'">Touch</button>',
      'mobile'
    );
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    expect(await page.evaluate(() => navigator.userAgent)).toContain('Mobile');
    const before = await session.observe();
    expect((await session.act({ type: 'click', ref: ref(before, 'Touch') })).status).toBe('ok');
    expect(await page.locator('button').getAttribute('data-pointer')).toBe('touch');
    expect(await page.locator('button').getAttribute('data-clicked')).toBe('yes');
    expect(
      (
        await session.act({
          type: 'drag',
          ref: ref(await session.observe(), 'Touch'),
          dx: 30,
          dy: 0,
        })
      ).status
    ).toBe('not-actionable');
  });

  it.each([
    'desktop',
    'mobile',
  ] as const)('applies locale and Accept-Language to the %s context', async viewport => {
    const page = await fixture('<p>Locale</p>', viewport);
    expect(await page.evaluate(() => navigator.language)).toBe('it-IT');
    await page.route('https://locale.example.test/', route =>
      route.fulfill({ body: 'Localized page' })
    );
    const request = page.waitForRequest('https://locale.example.test/');
    await page.goto('https://locale.example.test/');
    expect((await request).headers()['accept-language']).toBe('it-IT');
  });

  it('uses the mobile viewport and saves a trace while closing only its context', async () => {
    const page = await fixture('<button>Mobile</button>', 'mobile');
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    const other = await browser.newContext();
    try {
      await session.observe();
      const { tracePath } = await session.close();
      expect((await readFile(tracePath)).subarray(0, 2).toString()).toBe('PK');
      expect(browser.contexts()).toContain(other);
      sessionClosed = true;
    } finally {
      await other.close();
    }
  });
});
