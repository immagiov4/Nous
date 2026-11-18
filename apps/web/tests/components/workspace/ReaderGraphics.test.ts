import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import {
  GUIDED_PATH_MAX_STEPS,
  isLessonScene,
  type LessonScene,
  LessonSceneSchema,
} from '@shared/lessonScene';
import { type Browser, chromium, devices, type Locator } from 'playwright';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { withMutedAudio } from '../../../../../scripts/browser-audio';
import { FIXED_AUDIO_SECONDS, fixedAudio } from '../../fixtures/fixedAudio';

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

const processItems = [
  {
    label: 'Collect the sample',
    detail: 'The field technician collects a sample at the marked location.',
    icon: 'flask',
  },
  {
    label: 'Seal the container',
    detail: 'An airtight container protects the sample until it reaches the lab.',
    icon: 'lock',
  },
  {
    label: 'Record the location',
    detail: 'Record the coordinates and collection date so the lab can trace the sample.',
    icon: 'map-pin',
  },
  {
    label: 'Deliver the sample',
    detail: 'Hand the sealed container to the technician responsible for the measurements.',
    icon: 'truck',
  },
  {
    label: 'Check the seal',
    detail: 'The lab technician confirms the container stayed closed during transport.',
    icon: 'check',
  },
  {
    label: 'Measure the sample under the same conditions',
    detail: 'Record the measurement and its units so the reviewer can compare the same quantity.',
    icon: 'ruler',
  },
  { label: 'Review the measurement', detail: 'Second technician', icon: 'eye' },
  { label: 'Publish the result', detail: 'Signed report', icon: 'file' },
  {
    label: 'Archive the raw data',
    detail: 'Keep the original readings with the report.',
    icon: 'archive',
  },
  {
    label: 'Confirm receipt',
    detail: 'The requesting team acknowledges the report.',
    icon: 'mail',
  },
  {
    label: 'Reconcile the record',
    detail: 'Check that both teams have the same sample identifier.',
    icon: 'list-check',
  },
  {
    label: 'Close the request',
    detail: 'The coordinator marks the record complete.',
    icon: 'circle-check',
  },
];

const orderedScene = (type: 'process' | 'steps', count: number) =>
  LessonSceneSchema.parse({
    type,
    title: `${count} stages in ${type === 'process' ? 'sample handling' : 'the saved lesson'}`,
    body: '',
    items: processItems.slice(0, count),
    groups: [],
    note: '',
    quote: '',
  });

const rowFitsScrollport = (row: Locator) =>
  row.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const port = element.closest('[data-ordered-scroll]')?.getBoundingClientRect();
    return Boolean(port && bounds.top >= port.top && bounds.bottom <= port.bottom);
  });

const processNumbers = (card: Locator) =>
  card.locator('.q-index').evaluateAll(numbers =>
    numbers.map(number => {
      const text = document.createRange();
      text.selectNodeContents(number);
      const copy = number.nextElementSibling;
      if (!copy) throw new Error('Each process number needs its stage text');
      return {
        number: Number(number.textContent),
        lines: text.getClientRects().length,
        clearOfCopy: text.getBoundingClientRect().right <= copy.getBoundingClientRect().left,
        copyOffset: Math.round(
          copy.getBoundingClientRect().left - number.getBoundingClientRect().left
        ),
      };
    })
  );

test.each(
  contexts
)('renders complete ordered scenes and seeks to either end in $device $colorScheme', async ({
  device,
  colorScheme,
}) => {
  const context = await browser.newContext({
    ...(device === 'mobile' ? devices['Pixel 7'] : { viewport: { width: 1440, height: 900 } }),
    colorScheme,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const fixture = `${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html`;
  const scenes = [
    orderedScene('process', 12),
    orderedScene('process', 8),
    orderedScene('process', 2),
    orderedScene('process', 6),
    orderedScene('steps', 8),
  ];
  try {
    expect(scenes.every(isLessonScene)).toBe(true);
    await page.addInitScript(
      payload => Object.assign(window, { readerGraphicsScenes: payload }),
      scenes
    );
    await page.goto(fixture);
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    for (const scene of scenes) {
      const card = page
        .locator(`.type-${scene.type}`)
        .filter({ has: page.getByRole('heading', { name: scene.title, exact: true }) });
      const rows = card.locator('li');
      const content = await rows.evaluateAll(items =>
        items.map(row => ({
          label: row.querySelector('strong')?.textContent,
          detail: row.querySelector('p')?.textContent,
          icon: row.querySelector('[data-icon]')?.getAttribute('data-icon'),
        }))
      );
      expect(content.map(item => [item.label, item.detail])).toEqual(
        scene.items.map(item => [item.label, item.detail])
      );
      if (scene.type === 'process') {
        expect(content.map(item => item.icon)).toEqual(scene.items.map(item => item.icon));
        const numbers = await processNumbers(card);
        expect(numbers).toEqual(
          scene.items.map((_, index) => ({
            number: index + 1,
            lines: 1,
            clearOfCopy: true,
            copyOffset: numbers[0].copyOffset,
          }))
        );
      }
    }

    await page.goto(`${fixture}?playback=process&scene-seek`);
    const scrollport = page.locator('[data-ordered-scroll]');
    const position = page.getByRole('slider', { name: 'Fixture playback position' });
    const rows = scrollport.getByRole('listitem');
    const emphasis = (row: Locator) =>
      row.evaluate(element => getComputedStyle(element).getPropertyValue('--motion-emphasis'));
    await expect.poll(() => emphasis(rows.first())).toBe('1');
    await expect.poll(() => rowFitsScrollport(rows.first())).toBe(true);
    if (device === 'desktop') expect(await rowFitsScrollport(rows.last())).toBe(false);
    await position.press('End');
    await position.press('ArrowLeft');
    await expect.poll(() => emphasis(rows.last())).toBe('1');
    await expect.poll(() => rowFitsScrollport(rows.last())).toBe(true);
    await position.press('Home');
    await position.press('ArrowRight');
    await expect.poll(() => emphasis(rows.first())).toBe('1');
    await expect.poll(() => rowFitsScrollport(rows.first())).toBe(true);
  } finally {
    await context.close();
  }
});

const comparisonCases = [
  {
    legacy: 'signals',
    kind: 'complementary',
    label: 'Read together',
    symbol: '+',
    icon: 'plus',
    panels: ['Clue', 'Interpretation'],
    entries: ['Wilting leaves', 'Check soil moisture'],
  },
  {
    legacy: 'balance',
    kind: 'tradeoff',
    label: 'Tradeoff',
    symbol: '⇄',
    icon: 'arrows-exchange',
    panels: ['Benefit', 'Cost'],
    entries: ['Less watering', 'Slower growth'],
  },
  {
    legacy: 'beforeafter',
    kind: 'leads',
    label: 'Becomes',
    symbol: '→',
    icon: 'arrow-right',
    panels: ['Before drying', 'After drying'],
    entries: ['Soft clay', 'Firm clay'],
  },
] as const;

const comparisonScene = (example: (typeof comparisonCases)[number]): LessonScene => ({
  type: 'comparison',
  title: example.label,
  body: '',
  note: '',
  quote: '',
  items: [],
  groups: example.panels.map((label, index) => ({
    label,
    items: [example.entries[index]],
    icons: [index === 0 ? 'seedling' : 'droplet'],
  })),
  relation: { kind: example.kind, label: example.label, evidence: example.entries.join(' ') },
});

test.each(
  contexts
)('preserves comparison relations and historical scenes in $device $colorScheme', async ({
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
  const evidence = process.env.NOUS_COMPARISON_EVIDENCE;
  const description = `${device}-${colorScheme}`;
  const errors: string[] = [];
  const started = performance.now();
  const fixture = `${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html`;
  const cases = comparisonCases.map(example => {
    const comparison = comparisonScene(example);
    const historical: LessonScene = { ...comparison, type: example.legacy, relation: undefined };
    return { example, scenes: [comparison, historical] };
  });
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await context.tracing.start({ snapshots: true, screenshots: true });
  }
  try {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(
      scenes => {
        const index = Number(new URL(location.href).searchParams.get('scene'));
        Object.assign(window, { readerGraphicsScenes: [scenes[index]] });
      },
      cases.flatMap(entry => entry.scenes)
    );
    for (const [caseIndex, { example, scenes }] of cases.entries()) {
      for (const surface of ['reader', 'playback'] as const) {
        for (const [sceneIndex, scene] of scenes.entries()) {
          const index = caseIndex * scenes.length + sceneIndex;
          await page.goto(`${fixture}?scene=${index}${surface === 'reader' ? '' : '&playback'}`);
          const figure = page.locator(`.lesson-scene:has(.type-${scene.type})`);
          const groups = figure.locator('.groups');
          const panels = groups.locator('section');
          await panels.last().waitFor();
          expect(await panels.locator('h3').allTextContents()).toEqual([...example.panels]);
          expect(await panels.locator('li').allTextContents()).toEqual([...example.entries]);
          if (scene.type === 'balance') {
            expect(await figure.locator('.fulcrum').isVisible()).toBe(true);
          } else {
            const marker = groups.locator('.relation');
            expect(await marker.isVisible()).toBe(true);
            if (scene.type === 'comparison') {
              expect(await marker.getAttribute('aria-label')).toBe(example.label);
              if (surface === 'reader') {
                expect(await marker.textContent()).toBe(example.symbol);
              } else {
                const icon = marker.locator('.meaning-icon');
                await expect
                  .poll(() => icon.evaluate(el => getComputedStyle(el).maskImage))
                  .toContain('%3Cpath');
                expect(await icon.getAttribute('data-icon')).toBe(example.icon);
              }
            }
            if (example.kind === 'leads') {
              const [first, second] = await Promise.all([
                panels.first().boundingBox(),
                panels.last().boundingBox(),
              ]);
              expect(first).toBeTruthy();
              expect(second).toBeTruthy();
              if (!first || !second)
                throw new Error('Comparison panels must have a rendered size.');
              const stacked = second.y >= first.y + first.height - 1;
              expect(second.x > first.x || stacked).toBe(true);
              expect(
                await marker
                  .locator('.relation-symbol')
                  .evaluate(el => getComputedStyle(el).transform)
              ).toBe(stacked ? 'matrix(0, 1, -1, 0, 0, 0)' : 'none');
              if (mobile && surface === 'reader') expect(stacked).toBe(true);
            }
          }
          if (evidence) {
            await page.evaluate(() => document.fonts.ready);
            await figure.screenshot({
              path: join(evidence, `${description}-${surface}-${example.legacy}-${scene.type}.png`),
            });
          }
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    if (evidence) {
      await context.tracing.stop({ path: join(evidence, `${description}.zip`) });
      await writeFile(
        join(evidence, `${description}.json`),
        JSON.stringify({ elapsedMs: performance.now() - started, errors })
      );
    }
    await context.close();
  }
});

const guidedSpeech = 'Begin. Collect the sample. Check the seal. Store it safely.';
const guidedSteps = [
  { anchor: 'Collect', label: 'Collection', detail: 'Record the collection site.' },
  { anchor: 'Check', label: 'Inspection', detail: 'Keep the seal intact.' },
  { anchor: 'Store', label: 'Storage', detail: 'Use the designated shelf.' },
];
const guidedScene = LessonSceneSchema.parse({
  type: 'guided-path',
  title: 'Follow a sample to storage',
  body: 'Follow the active stage.',
  autoplay: true,
  durationMs: 900,
  narration: guidedSpeech,
  steps: guidedSteps,
  items: [],
  groups: [],
  note: '',
  quote: '',
});

test('reveals each guided detail exactly at its narration cue and reverses on a seek', async () => {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  try {
    await page.addInitScript(
      scene => Object.assign(window, { readerGraphicsScenes: [scene] }),
      guidedScene
    );
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html?playback=guided-path&scene-seek`
    );
    const clock = page.getByRole('slider', { name: 'Fixture playback position' });
    const card = page.locator('.type-guided-path');
    const detail = card.locator('.path-explanation p');
    const active = card.locator('[aria-current="step"] strong');
    await expect
      .poll(() =>
        card.evaluate(element => {
          const host = element.closest('.scene-host');
          return host ? getComputedStyle(host).getPropertyValue('--scene-scale') : '';
        })
      )
      .toBe('1');
    for (const [time, label, expected] of [
      ['1.1', null, 'Follow the active stage.'],
      ['1.2', 'Collection', 'Record the collection site.'],
      ['4.7', 'Collection', 'Record the collection site.'],
      ['4.8', 'Inspection', 'Keep the seal intact.'],
      ['8.3', 'Inspection', 'Keep the seal intact.'],
      ['8.4', 'Storage', 'Use the designated shelf.'],
      ['4.8', 'Inspection', 'Keep the seal intact.'],
      ['1.1', null, 'Follow the active stage.'],
    ] as const) {
      await clock.fill(time);
      await expect.poll(() => detail.textContent()).toBe(expected);
      expect(await active.allTextContents()).toEqual(label ? [label] : []);
    }
    await clock.press('End');
    const review = card.locator('.path-details li:visible');
    await expect
      .poll(() => review.locator('p').allTextContents())
      .toEqual(guidedSteps.map(step => step.detail));
    expect(await review.locator('strong').allTextContents()).toEqual(
      guidedSteps.map(step => step.label)
    );
    expect(await active.count()).toBe(0);
    await clock.fill('4.8');
    await expect.poll(() => detail.textContent()).toBe('Keep the seal intact.');
    await expect.poll(() => review.count()).toBe(0);
    expect(await active.allTextContents()).toEqual(['Inspection']);
  } finally {
    await page.close();
  }
});

test('keeps a full guided path readable and scrollable on a phone after the narration ends', async () => {
  const page = await browser.newPage({ ...devices['Pixel 7'], reducedMotion: 'reduce' });
  try {
    const steps = Array.from({ length: GUIDED_PATH_MAX_STEPS }, (_, index) => ({
      label: `Stage ${index + 1}`,
      detail:
        'Check the envelope and write down everything you need to identify this seed batch later.',
    }));
    await page.addInitScript(scene => Object.assign(window, { readerGraphicsScenes: [scene] }), {
      ...guidedScene,
      steps,
    });
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html?playback=guided-path&scene-seek`
    );
    await page.getByRole('slider', { name: 'Fixture playback position' }).press('End');
    const host = page.locator('.scene-host[data-ordered-overflow]');
    const scroll = host.locator('[data-ordered-scroll]');
    const rows = scroll.locator('.path-details li:visible');
    await expect.poll(() => rows.count()).toBe(steps.length);
    expect(await host.evaluate(card => card.style.getPropertyValue('--scene-scale'))).toBe('1');
    expect(await rowFitsScrollport(rows.last())).toBe(false);
    await scroll.press('End');
    await expect.poll(() => rowFitsScrollport(rows.last())).toBe(true);
    expect(await rows.last().innerText()).toContain(steps.at(-1)?.detail);
  } finally {
    await page.close();
  }
});

test.each([
  { reducedMotion: 'reduce', autoplay: true },
  { reducedMotion: 'no-preference', autoplay: false },
  { reducedMotion: 'no-preference', autoplay: true },
] as const)('standalone path makes every detail readable ($reducedMotion, autoplay $autoplay)', async ({
  reducedMotion,
  autoplay,
}) => {
  const page = await browser.newPage({ reducedMotion });
  try {
    await page.addInitScript(scene => Object.assign(window, { readerGraphicsScenes: [scene] }), {
      ...guidedScene,
      autoplay,
    });
    await page.goto(`${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html`);
    const rows = page.locator('.type-guided-path').getByRole('listitem');
    await expect
      .poll(() => rows.locator('p:visible').allTextContents(), { timeout: 4_000 })
      .toEqual([
        'Record the collection site.',
        'Keep the seal intact.',
        'Use the designated shelf.',
      ]);
    expect(await rows.locator('strong:visible').allTextContents()).toEqual([
      'Collection',
      'Inspection',
      'Storage',
    ]);
  } finally {
    await page.close();
  }
});

test.each([
  'audio ends',
  'seek to end',
] as const)('keeps every guided detail readable when %s on the audio clock', async ending => {
  const page = await browser.newPage({
    ...(ending === 'seek to end' ? devices['Pixel 7'] : {}),
    reducedMotion: 'reduce',
  });
  try {
    const duration = FIXED_AUDIO_SECONDS + 0.25;
    const bytes = Buffer.from(fixedAudio(duration));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const block = {
      ...segmentLessonPlayback([{ type: 'markdown', markdown: guidedSpeech }])[0],
      visuals: [{ kind: 'scene', scene: guidedScene }],
      audio: [
        {
          voice: 'Kore',
          model: 'local-sample',
          durationSeconds: duration,
          asset: { id: hash, hash, byteSize: bytes.length, mediaType: 'audio/wav' },
        },
      ],
    };
    await page.route('**/api/projects/audio-contract/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.includes('/assets/'))
        return route.fulfill({ contentType: 'audio/wav', body: bytes });
      return route.fulfill({
        json: url.pathname.endsWith('/prepare')
          ? { block, voice: 'Kore', model: 'local-sample' }
          : { lessonKey: hash, blocks: [block] },
      });
    });
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/audio-production.html?${new URLSearchParams({ speech: guidedSpeech })}`
    );
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const transport = page.locator('output[data-position]');
    await transport.getByText('playing', { exact: true }).waitFor();
    // Web Audio can resample the WAV during decoding, so the clip can end before its metadata.
    const decodedDuration = Number(await transport.getAttribute('data-duration'));
    expect(decodedDuration).toBeGreaterThan(0);
    const slider = page.getByRole('slider');
    const card = page.locator('.type-guided-path');
    const review = card.locator('.path-details li:visible');
    const firstDetail = card
      .locator('.path-explanation p')
      .filter({ hasText: guidedSteps[0].detail });
    await firstDetail.waitFor();
    expect(await review.count()).toBe(0);
    if (ending === 'seek to end') await slider.press('End');
    await expect
      .poll(() => transport.textContent(), {
        timeout: (duration + 5) * 1000,
      })
      .toBe('idle');
    expect(Number(await transport.getAttribute('data-position'))).toBe(decodedDuration);
    await expect
      .poll(() => review.locator('p').allTextContents())
      .toEqual(guidedSteps.map(step => step.detail));
    expect(await review.locator('strong').allTextContents()).toEqual(
      guidedSteps.map(step => step.label)
    );
    if (ending === 'seek to end') {
      const resumeAt = 2;
      await slider.fill(String(resumeAt));
      await slider.press('Tab');
      await expect
        .poll(async () => Number(await transport.getAttribute('data-position')))
        .toBe(resumeAt);
      expect(await transport.textContent()).toBe('idle');
      await firstDetail.waitFor();
      expect(await review.count()).toBe(0);
    }
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await transport.getByText('playing', { exact: true }).waitFor();
    await firstDetail.waitFor();
    if (ending === 'seek to end') {
      await card
        .locator('.path-explanation p')
        .filter({ hasText: guidedSteps[1].detail })
        .waitFor();
    }
  } finally {
    await page.close();
  }
}, 25_000);

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

test('puts shutter labels, icons and details directly on the ring when they fit', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.addInitScript(() => {
      Object.assign(window, {
        readerGraphicsScenes: [
          {
            type: 'flywheel',
            title: 'Camera shutter',
            body: '',
            note: '',
            quote: '',
            groups: [],
            items: [
              { label: 'Open', detail: 'Expose the sensor', icon: 'camera' },
              { label: 'Close', detail: 'Read the exposure', icon: 'lock' },
            ],
          },
        ],
      });
    });
    await page.goto(`${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html`);
    const ring = page.locator('.q-cycle:visible');
    await ring.waitFor();
    const nodes = ring.locator('.q-cycle-node');
    await expect
      .poll(() => nodes.allTextContents())
      .toEqual(['OpenExpose the sensor', 'CloseRead the exposure']);
    expect(
      await nodes
        .locator('.meaning-icon')
        .evaluateAll(elements => elements.map(element => element.getAttribute('data-icon')))
    ).toEqual(['camera', 'lock']);
    expect(await ring.locator('svg > g > path:first-child').count()).toBe(2);
    expect(await page.locator('.q-cycle-details:visible').count()).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => nodes.locator('strong').allTextContents()).toEqual(['Open', 'Close']);
    expect(await nodes.locator('p:visible').count()).toBe(0);
    expect(await cycleStationInsets(ring)).toEqual([
      [8, 8, 8, 8],
      [8, 8, 8, 8],
    ]);
    await page.setViewportSize({ width: 280, height: 900 });
    const key = page.locator('.q-cycle-details:visible');
    await key.waitFor();
    expect(await key.locator('li').allTextContents()).toEqual([
      'OpenExpose the sensor',
      'CloseRead the exposure',
    ]);
    expect(await key.locator('p:visible').count()).toBe(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(() => nodes.allTextContents())
      .toEqual(['OpenExpose the sensor', 'CloseRead the exposure']);
    expect(await nodes.locator('p:visible').count()).toBe(2);
  } finally {
    await page.close();
  }
});

test('keeps a detailed cycle center and icon readable during phone playback', async () => {
  const page = await browser.newPage({
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  try {
    const center =
      'Forecast model updated every turn using the error measured against actual demand';
    await page.addInitScript(text => {
      Object.assign(window, {
        readerGraphicsScenes: [
          {
            type: 'flywheel',
            title: 'Forecasting feedback',
            center: text,
            icon: 'device-desktop',
            body: '',
            note: '',
            quote: '',
            groups: [],
            items: [
              { label: 'Measure', detail: 'Record actual demand', icon: 'point' },
              { label: 'Compare', detail: 'Find the forecast error', icon: 'point' },
              { label: 'Update', detail: 'Correct the model', icon: 'point' },
            ],
          },
        ],
      });
    }, center);
    await page.goto(
      `${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html?playback=flywheel`
    );
    const hub = page.locator('.q-cycle-center:visible');
    await hub.waitFor();
    await page.evaluate(() => document.fonts.ready);
    expect(await hub.textContent()).toBe(center);
    expect(await hub.locator('[data-icon="device-desktop"]').count()).toBe(1);
    expect(
      await hub.evaluate(element => {
        const box = element.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(element);
        return [...text.getClientRects()].every(
          rect =>
            rect.width === 0 ||
            (rect.top >= box.top - 1 &&
              rect.bottom <= box.bottom + 1 &&
              rect.left >= box.left - 1 &&
              rect.right <= box.right + 1)
        );
      })
    ).toBe(true);
  } finally {
    await page.close();
  }
});

test.each([
  '',
  '?playback=flywheel',
])('keeps the full cycle arrowhead visible at nearby card widths (%s)', async route => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.addInitScript(() => {
      Object.assign(window, {
        readerGraphicsScenes: [
          {
            type: 'flywheel',
            title: 'Forecasting feedback',
            center: 'Forecast model',
            body: '',
            note: '',
            quote: '',
            groups: [],
            items: [
              { label: 'Measure', detail: 'Record actual demand', icon: 'ruler' },
              { label: 'Compare', detail: 'Find the forecast error', icon: 'list-check' },
              {
                label: 'Update',
                detail: 'Correct the model before the next forecast',
                icon: 'refresh',
              },
            ],
          },
        ],
      });
    });
    await page.goto(`${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html${route}`);
    const scene = page.locator('.type-flywheel');
    await scene.waitFor();
    await page.evaluate(() => document.fonts.ready);

    for (const width of [470, 474, 480]) {
      await scene.evaluate((element, width) => {
        (element as HTMLElement).style.width = `${width}px`;
        return new Promise<void>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      }, width);
      expect(await scene.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
      const ring = scene.locator('.q-cycle:visible');
      const arrow = ring.locator('svg > g > path:nth-child(2)').nth(1);
      await expect
        .poll(() =>
          arrow.evaluate(path => {
            if (!(path instanceof SVGPathElement)) throw new Error('Expected the arrowhead path.');
            const matrix = path.getScreenCTM();
            const frame = path.closest('.q-cycle');
            if (!matrix || !frame) throw new Error('Expected a visible cycle.');
            const node = frame.querySelectorAll('.q-cycle-node')[2].getBoundingClientRect();
            const length = path.getTotalLength();
            // Sample both sides of Compare → Update, including between the vertices.
            return Array.from({ length: 101 }, (_, index) =>
              path.getPointAtLength((length * index) / 100).matrixTransform(matrix)
            ).filter(
              point =>
                point.x > node.left &&
                point.x < node.right &&
                point.y > node.top &&
                point.y < node.bottom
            ).length;
          })
        )
        .toBe(0);
      const key = scene.locator('.q-cycle-details:visible');
      await expect.poll(() => key.count()).toBe(1);
      expect(
        await scene.locator('.q-cycle:not([inert]) p, .q-cycle-details p').allTextContents()
      ).toEqual([
        'Record actual demand',
        'Find the forecast error',
        'Correct the model before the next forecast',
      ]);
    }
  } finally {
    await page.close();
  }
});

const cycleStationInsets = (ring: Locator) =>
  ring.locator('.q-cycle-node').evaluateAll(nodes =>
    nodes.map(node => {
      const group = node.querySelector('strong');
      if (!group) throw new Error('Expected the station contents.');
      const outside = node.getBoundingClientRect();
      const inside = group.getBoundingClientRect();
      const style = getComputedStyle(node);
      return [
        inside.top - outside.top - Number.parseFloat(style.borderTopWidth),
        outside.right - inside.right - Number.parseFloat(style.borderRightWidth),
        outside.bottom - inside.bottom - Number.parseFloat(style.borderBottomWidth),
        inside.left - outside.left - Number.parseFloat(style.borderLeftWidth),
      ].map(Math.round);
    })
  );

const cycleLayoutProblems = (ring: Locator) =>
  ring.evaluate(element => {
    const frame = element.getBoundingClientRect();
    const nodes = [...element.querySelectorAll('.q-cycle-node')];
    const boxes = nodes.map(node => node.getBoundingClientRect());
    const center =
      element.querySelector('.q-cycle-center') ??
      element
        .closest('.q-cycle-keyed-layout:not([data-center-below])')
        ?.querySelector('.q-cycle-center');
    const textRects = (text: Element) => {
      const range = document.createRange();
      range.selectNodeContents(text);
      return [...range.getClientRects()];
    };
    const centerRects = center ? textRects(center) : [];
    const contains = (outer: DOMRect, inner: DOMRect) =>
      inner.left >= outer.left &&
      inner.right <= outer.right &&
      inner.top >= outer.top &&
      inner.bottom <= outer.bottom;
    const overlap = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const arrowheads = element
      .closest('.q-cycle-layout')
      ?.querySelectorAll<SVGPathElement>('.q-cycle:not([inert]) > svg > g > path:nth-child(2)');
    if (!arrowheads?.length) throw new Error('Expected the cycle arrows.');
    const stroke =
      (Number.parseFloat(getComputedStyle(arrowheads[0]).strokeWidth) * frame.width) / 200;
    const content = [...boxes, ...centerRects];
    const blockedArrows = [...arrowheads].filter(arrow => {
      const length = arrow.getTotalLength();
      return Array.from({ length: 201 }, (_, index) =>
        arrow.getPointAtLength((length * index) / 200)
      ).some(point => {
        const x = frame.left + (point.x * frame.width) / 100;
        const y = frame.top + (point.y * frame.height) / 100;
        return content.some(
          rect =>
            x >= rect.left - stroke &&
            x <= rect.right + stroke &&
            y >= rect.top - stroke &&
            y <= rect.bottom + stroke
        );
      });
    });
    const clippedLabels = nodes.flatMap(node => {
      const title = node.querySelector('.q-cycle-label');
      const group = node.querySelector('strong');
      return title &&
        group &&
        textRects(title).some(rect => !contains(group.getBoundingClientRect(), rect))
        ? [title.textContent]
        : [];
    });
    return {
      overflow: content.some(rect => !contains(frame, rect)),
      overlap: boxes.some((box, index) =>
        [...boxes.slice(index + 1), ...centerRects].some(rect => overlap(box, rect))
      ),
      clippedLabels,
      blockedArrows: blockedArrows.length,
    };
  });

const forecastStations = [
  { label: 'Misura la domanda', detail: 'Registra la domanda reale', icon: 'ruler' },
  { label: 'Confronta i dati', detail: 'Trova l’errore della previsione', icon: 'list-check' },
  {
    label: 'Aggiorna il modello',
    detail: 'Correggi il modello prima della previsione',
    icon: 'refresh',
  },
  { label: 'Verifica il risultato', detail: 'Controlla il giro successivo', icon: 'circle-check' },
];

const shortCycleStations = [
  { label: 'Read', detail: 'Read the draft', icon: 'book' },
  { label: 'Plan', detail: 'Choose a change', icon: 'list-check' },
  { label: 'Try', detail: 'Make the change', icon: 'pencil' },
  { label: 'Check', detail: 'Read the draft again', icon: 'check' },
];

test.each([
  [320, 'reader'],
  [390, 'reader'],
  [320, 'player'],
  [390, 'player'],
] as const)('shows only full station names and icons at %i px in the %s', async (width, surface) => {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width, height: 844 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const route = surface === 'player' ? '?playback=flywheel' : '';
  const dense = [
    ...forecastStations,
    { label: 'Raccogli nuovi dati sul campo', detail: 'Ripeti la misura', icon: 'database' },
    {
      label: 'Interoperabilitàelettroencefalografica',
      detail: 'Rivedi il risultato',
      icon: 'activity',
    },
  ];
  try {
    for (const { items, expected, monospace } of [
      { items: forecastStations.slice(0, 3), expected: 'measured' },
      { items: forecastStations, expected: 'measured' },
      { items: shortCycleStations, expected: 'names' },
      { items: shortCycleStations, expected: 'names', monospace: true },
      { items: dense, expected: 'numbers' },
    ]) {
      const page = await context.newPage();
      try {
        await page.addInitScript(
          ({ items, expected }) => {
            Object.assign(window, {
              readerGraphicsScenes: [
                {
                  type: 'flywheel',
                  title: 'Correggere una previsione',
                  center: expected === 'names' ? 'Draft' : 'Modello di previsione',
                  body: '',
                  note: '',
                  quote: '',
                  groups: [],
                  items,
                },
              ],
            });
          },
          { items, expected }
        );
        await page.goto(`${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html${route}`);
        const scene = page.locator('.type-flywheel');
        await scene.waitFor();
        if (monospace) {
          await page.addStyleTag({
            content: '.q-cycle-node, .q-cycle-center { font-family: monospace; }',
          });
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          );
        });
        const ring = scene.locator('.q-cycle:visible');
        const key = scene.locator('.q-cycle-details:visible');
        const keyed = (await key.count()) === 1;
        if (expected !== 'measured') expect(keyed).toBe(expected === 'numbers');
        expect(await cycleLayoutProblems(ring)).toEqual({
          overflow: false,
          overlap: false,
          clippedLabels: [],
          blockedArrows: 0,
        });
        const stationLabels = keyed
          ? key.locator('li strong')
          : ring.locator('.q-cycle-node strong');
        expect(await stationLabels.allTextContents()).toEqual(items.map(item => item.label));
        const icons = await stationLabels
          .locator('.meaning-icon')
          .evaluateAll(elements => elements.map(icon => icon.getAttribute('data-icon')));
        expect(icons).toEqual(items.map(item => item.icon));
        expect(await scene.locator('.q-cycle-layout p:visible').count()).toBe(0);
        expect(await ring.locator('svg > g > path:nth-child(2)').count()).toBe(items.length);
        for (const { label } of items) {
          expect(
            await scene.getByText(label, { exact: true }).filter({ visible: true }).count()
          ).toBe(1);
        }
        const linePositions = await stationLabels.locator('.q-cycle-label').evaluateAll(labels =>
          labels.map(label => {
            const range = document.createRange();
            const text = label.firstChild;
            if (!(text instanceof Text)) throw new Error('Expected the authored name.');
            return [...text.data.matchAll(/\S+/gu)].map(word => {
              range.setStart(text, word.index);
              range.setEnd(text, word.index + word[0].length);
              return [...range.getClientRects()].map(rect => Math.round(rect.top));
            });
          })
        );
        expect(linePositions.every(label => label.every(word => word.length === 1))).toBe(true);
        if (keyed) {
          expect(await ring.locator('.q-cycle-node strong').allTextContents()).toEqual(
            items.map((_, index) => String(index + 1))
          );
          const rejected = await cycleLayoutProblems(scene.locator('.q-cycle-direct'));
          expect(
            rejected.overflow ||
              rejected.overlap ||
              rejected.clippedLabels.length > 0 ||
              rejected.blockedArrows > 0
          ).toBe(true);
          if (items === dense) {
            const longTitle = key.locator('li').last().locator('.q-cycle-label');
            const word = await longTitle.evaluate(element => {
              const range = document.createRange();
              range.selectNodeContents(element);
              const lines = new Set([...range.getClientRects()].map(rect => rect.top)).size;
              (element as HTMLElement).scrollLeft = element.scrollWidth;
              return { lines, canReadEnd: element.scrollLeft > 0 };
            });
            expect(word).toEqual({ lines: 1, canReadEnd: true });
            if (width === 320) expect(new Set(linePositions[4].flat()).size).toBeGreaterThan(1);
          }
        } else {
          const insets = await cycleStationInsets(ring);
          expect(insets.every(station => station.every(inset => inset >= 8))).toBe(true);
          if (expected === 'names') {
            expect(linePositions.every(label => new Set(label.flat()).size === 1)).toBe(true);
          }
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
  }
});

test.each([
  '',
  '?playback=flywheel',
])('keeps every center character clear of the numbered ring (%s)', async route => {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 320, height: 844 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const scenes = ['Forecast model', 'W'.repeat(80)].map(center => ({
    type: 'flywheel',
    title: 'Forecast cycle',
    center,
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: Array.from({ length: 6 }, (_, index) => ({
      label: `Check the result and record the next measurement ${index + 1}`,
      detail: '',
      icon: 'point',
    })),
  }));
  try {
    for (const [index, fixture] of scenes.entries()) {
      const page = await context.newPage();
      await page.addInitScript(fixture => {
        Object.assign(window, { readerGraphicsScenes: [fixture] });
      }, fixture);
      await page.goto(`${inject('browserFixtureUrl')}tests/fixtures/readerGraphics.html${route}`);
      const scene = page.locator('.type-flywheel');
      const ring = scene.locator('.q-cycle:visible');
      await ring.waitFor();
      expect(await scene.locator('.q-cycle-details:visible').count()).toBe(1);
      const center = scene.locator('.q-cycle-center:visible');
      expect(await center.textContent()).toBe(fixture.center);
      expect(await cycleLayoutProblems(ring)).toEqual({
        overflow: false,
        overlap: false,
        clippedLabels: [],
        blockedArrows: 0,
      });
      const ringBox = await ring.boundingBox();
      const centerBox = await center.boundingBox();
      if (!ringBox || !centerBox) throw new Error('Expected the ring and center.');
      expect(centerBox.y >= ringBox.y + ringBox.height).toBe(index === 1);
      await page.close();
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
