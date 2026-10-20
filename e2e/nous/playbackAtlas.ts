import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-js';
import {
  type Browser,
  type BrowserContext,
  type BrowserServer,
  chromium,
  type Page,
} from 'playwright';
import { build, type CSSOptions, normalizePath, preview } from 'vite';
import { drainConsoleSignals, installProbes } from '../../packages/playtest/src/probes/collect';
import type { LessonPlaybackBlock } from '../../packages/shared-types/lessonPlayback';
import {
  type AtlasFinding,
  outsideBox,
  POSITIONS,
  type Position,
  visualFindings,
} from './atlas/checks';
import type { AtlasSample } from './atlas/contracts';
import { inspectAtlasDom, inspectAtlasGeometry } from './atlas/dom';
import { boundedRender } from './atlas/execution';
import { type AtlasCourse, type AtlasLesson, atlasCourses, atlasLessons } from './atlas/input';
import {
  type AtlasTile,
  THRESHOLD_DECISIONS,
  writeAtlasArtifact,
  writeAtlasIndex,
  writeAtlasSheet,
} from './atlas/report';
import {
  type AtlasScenario,
  AtlasScenarioSchema,
  type AtlasViewport,
  readAtlasScenario,
  viewportOptions,
} from './atlas/scenario';
import { speechPunctuationTokens } from './atlas/speech';
import {
  ATLAS_FRAME_MS,
  advanceAtlasLayout,
  installAtlasClock,
  installAtlasFrameClock,
  resetAtlasRandom,
  resetAtlasSample,
  waitForAtlasEntry,
} from './atlas/timing';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Maximum healthy startup/capture/sheet phase: 34,093.1062 ms across 258 samples; margin 1.5x.
const DEFAULT_RENDER_TIMEOUT_MS = 51_140;

export function parseAtlasArgs(args: string[]) {
  const { values } = parseArgs({
    args: args.filter(argument => argument !== '--'),
    strict: true,
    options: {
      library: { type: 'string' },
      fixture: { type: 'string' },
      synthetic: { type: 'string' },
      scenario: { type: 'string' },
      'source-root': { type: 'string' },
      'output-root': { type: 'string' },
      course: { type: 'string' },
      'render-timeout-ms': { type: 'string' },
      lesson: { type: 'string' },
    },
  });
  if ([values.library, values.fixture, values.synthetic].filter(Boolean).length > 1)
    throw new Error('Choose one input: --library, --fixture or --synthetic.');
  if (values.synthetic && !['synthetic-short', 'synthetic-law-short'].includes(values.synthetic))
    throw new Error('Unknown synthetic course.');
  const renderTimeoutMs = Number(values['render-timeout-ms'] ?? DEFAULT_RENDER_TIMEOUT_MS);
  if (!Number.isFinite(renderTimeoutMs) || renderTimeoutMs <= 0)
    throw new Error('Choose a measured positive --render-timeout-ms execution bound.');
  return {
    renderTimeoutMs,
    scenarioPath: values.scenario,
    library: values.library,
    fixture: values.fixture,
    synthetic: values.synthetic as 'synthetic-short' | 'synthetic-law-short' | undefined,
    sourceRoot: resolve(values['source-root'] ?? REPO_ROOT),
    outputRoot: resolve(values['output-root'] ?? join(homedir(), 'nous-atlas')),
    course: values.course,
    lesson: values.lesson,
  };
}
type Options = ReturnType<typeof parseAtlasArgs>;
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export function assertWindowsAtlasLocation(path: string, profile: string) {
  const location = win32.relative(win32.resolve(profile), win32.resolve(path));
  if (location === '..' || location.startsWith(`..${win32.sep}`) || win32.isAbsolute(location))
    throw new Error('Windows atlas output must be inside the user profile and inherit its ACLs.');
}

export function atlasKatexCss(sourceRoot: string) {
  const sourceRequire = createRequire(join(sourceRoot, 'package.json'));
  return createRequire(sourceRequire.resolve('rehype-katex')).resolve('katex/dist/katex.min.css');
}

export async function privateAtlasDirectory(outputRoot: string, sourceRoot: string) {
  if (process.platform === 'win32') assertWindowsAtlasLocation(outputRoot, homedir());
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const canonical = await realpath(outputRoot);
  if (process.platform === 'win32')
    assertWindowsAtlasLocation(canonical, await realpath(homedir()));
  for (const root of [REPO_ROOT, sourceRoot]) {
    const path = relative(await realpath(root), canonical);
    if (!path || (!path.startsWith('..') && !isAbsolute(path)))
      throw new Error('Atlas output must stay outside the repository.');
  }
  // Resolve links first, then reject any other Git checkout as an output destination.
  let repository: string | undefined;
  try {
    repository = git(canonical, 'rev-parse', '--show-toplevel');
  } catch {
    /* Outside Git is required. */
  }
  if (repository) throw new Error('Atlas output must stay outside every Git repository.');
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}`;
  const directory = join(canonical, runId);
  await mkdir(directory, { mode: 0o700 });
  return { directory, runId };
}

async function settleAtlasDocument(timeSeconds: number) {
  await document.fonts.ready;
  for (const animation of document.getAnimations()) {
    if (animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY) {
      animation.pause();
      animation.currentTime = timeSeconds * 1000;
    } else animation.finish();
  }
}

async function settleStage(page: Page, timeSeconds: number) {
  // Layout selects the active visual; lazy diagram resources can then schedule further frames.
  // The parent supervisor bounds this readiness loop, including scripts that never yield.
  do {
    await advanceAtlasLayout(page);
  } while (!(await page.evaluate(() => window.playbackAtlas.ready())));

  // Replay each embedded document from the same epoch after its production host has settled.
  await resetAtlasSample(page);
  await page.locator('iframe').evaluateAll(frames =>
    Promise.all(
      frames.map(
        frame =>
          new Promise<void>(resolve => {
            frame.addEventListener('load', () => resolve(), { once: true });
            const source = frame.getAttribute('srcdoc');
            if (source === null) throw new Error('Atlas embedded documents must use srcdoc.');
            frame.setAttribute('srcdoc', source);
          })
      )
    )
  );
  for (const frame of page.frames()) {
    await frame.waitForLoadState('load');
    await frame.evaluate(settleAtlasDocument, timeSeconds);
  }
  await advanceAtlasLayout(page, timeSeconds);
  await advanceAtlasLayout(page);
}

async function captureSample(page: Page, sample: AtlasSample) {
  const started = performance.now();
  await resetAtlasSample(page);
  const prepared = await page.evaluate(input => window.playbackAtlas.render(input), sample);
  await settleStage(page, prepared.time);
  const dom = await page.evaluate(inspectAtlasDom, '.scene-host');
  const frameGeometry: { minFontPx: number | null; scale: number | null }[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const inner = await frame.evaluate(inspectAtlasDom, 'body');
    dom.text += ` ${inner.text}`;
    dom.prose += ` ${inner.prose}`;
    dom.mediaCount += inner.mediaCount;
    dom.mathCount += inner.mathCount;
    dom.clips.push(...inner.clips);
    dom.canvasPixels.push(...inner.canvasPixels);
    dom.errors.push(...inner.errors);
    const fonts = await frame.locator('body').evaluate(inspectAtlasGeometry);
    const host = await frame.frameElement();
    const scale = await host.evaluate(element => {
      const iframe = element as HTMLIFrameElement;
      return iframe.clientWidth ? iframe.getBoundingClientRect().width / iframe.clientWidth : null;
    });
    await host.dispose();
    frameGeometry.push({ minFontPx: fonts.minFontPx, scale });
  }
  const geometry = await page.locator('.scene-host').evaluate(inspectAtlasGeometry);
  const sizes = [
    geometry.minFontPx,
    ...frameGeometry.map(frame =>
      frame.minFontPx !== null && frame.scale !== null ? frame.minFontPx * frame.scale : null
    ),
  ].filter((size): size is number => size !== null);
  geometry.minFontPx = sizes.length ? Math.min(...sizes) : null;
  const findings: AtlasFinding[] = [
    ...prepared.findings,
    ...visualFindings(
      dom,
      prepared.time > 0 && prepared.time < prepared.duration ? prepared.speech : '',
      prepared.expectedVisual
    ),
    ...dom.clips.map(clip => ({
      kind: 'visual-clipped' as const,
      detail: { ...clip, excessPx: outsideBox(clip.box, clip.boundary) },
    })),
    ...dom.errors.map(detail => ({ kind: 'render-error' as const, detail })),
  ];
  const png = await page.screenshot();
  findings.push(
    ...drainConsoleSignals(page).map(signal => ({
      kind: 'console-error' as const,
      detail: signal,
    }))
  );
  return {
    png,
    findings,
    caption: prepared.captions.join(' '),
    speech: prepared.speech,
    metrics: {
      renderMs: performance.now() - started,
      speechPunctuationTokens: speechPunctuationTokens(prepared.speech),
      ...geometry,
      frameGeometry,
      visibleCharacters: Array.from(dom.text.trim()).length,
      visibleWords: Array.from(
        new Intl.Segmenter('it', { granularity: 'word' }).segment(dom.prose)
      ).filter(part => part.isWordLike).length,
      mathCount: dom.mathCount,
      mediaCount: dom.mediaCount,
      canvasPixels: dom.canvasPixels,
      expectedVisual: prepared.expectedVisual,
      mounted: dom.mounted,
      duration: prepared.duration,
      time: prepared.time,
    },
  };
}

interface CaptureLessonInput {
  page: Page;
  sheets: Page;
  directory: string;
  lesson: AtlasLesson;
  blocks: readonly LessonPlaybackBlock[];
  viewport: AtlasViewport;
  ordinal: number;
  checks: AtlasScenario['checks'];
  renderSample?: (sample: AtlasSample) => ReturnType<typeof captureSample>;
  sheetExecution: Parameters<typeof boundedRender>[1];
}
type CaptureTileInput = AtlasSample &
  Pick<CaptureLessonInput, 'page' | 'directory' | 'viewport' | 'checks' | 'renderSample'> & {
    basename: string;
  };

export async function captureTile(input: CaptureTileInput) {
  const { page, directory, lesson, block, position, visualIndex, viewport, basename } = input;
  const id = `${basename}-${position}`;
  const started = performance.now();
  let captured: {
    png: Buffer;
    caption: string;
    speech: string;
    findings: AtlasFinding[];
    metrics: unknown;
  };
  let incomplete = false;
  try {
    captured = await (input.renderSample ?? (sample => captureSample(page, sample)))({
      lesson,
      block,
      position,
      visualIndex,
    });
  } catch (error) {
    incomplete = true;
    captured = {
      // A failure card is generated outside the untrusted renderer; it is not a screenshot.
      png: Buffer.from(
        new Resvg(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${page.viewportSize()?.width}" height="${page.viewportSize()?.height}"><rect width="100%" height="100%" fill="white"/><text x="24" y="48" font-size="20" fill="black">RENDER FAILED - generated failure card</text></svg>`
        )
          .render()
          .asPng()
      ),
      caption: '',
      speech: block.speech,
      metrics: { incomplete: true, elapsedMs: performance.now() - started },
      findings: [
        { kind: 'render-error', detail: error instanceof Error ? error.message : String(error) },
      ],
    };
    captured.findings.push(
      ...drainConsoleSignals(page).map(signal => ({
        kind: 'console-error' as const,
        detail: signal,
      }))
    );
  }
  const image = `${id}.png`;
  await writeAtlasArtifact(join(directory, image), captured.png);
  const tile: AtlasTile = {
    id,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    courseId: lesson.projectId,
    courseTitle: lesson.courseTitle,
    blockId: block.id,
    visualIndex,
    position,
    viewport: viewport.id,
    viewportSize: page.viewportSize() as { width: number; height: number },
    image,
    html: `${basename}.html`,
    sheet: `${basename}.png`,
    caption: captured.caption,
    speech: captured.speech,
    findings: captured.findings.filter(
      finding =>
        incomplete || input.checks.includes(finding.kind as AtlasScenario['checks'][number])
    ),
    metrics: captured.metrics,
    incomplete,
  };
  return { tile, png: captured.png };
}

async function captureLesson(input: CaptureLessonInput): Promise<AtlasTile[]> {
  const { sheets, directory, viewport, ordinal } = input;
  const tiles: AtlasTile[] = [];
  // Production selection stays intact; isolated sheets cover visuals missed by coarse positions.
  const jobs = input.blocks.flatMap(block =>
    [null, ...block.visuals.map((_, index) => index)].map(visualIndex => ({ block, visualIndex }))
  );
  for (const job of jobs) {
    const variant = job.visualIndex === null ? 'stage' : `visual-${job.visualIndex}`;
    const basename = `lesson-${ordinal}-${viewport.id}-block-${job.block.id}-${variant}`;
    const batch: AtlasTile[] = [];
    const pngs: Buffer[] = [];
    for (const position of Object.keys(POSITIONS) as Position[]) {
      const captured = await captureTile({ ...input, ...job, position, basename });
      batch.push(captured.tile);
      pngs.push(captured.png);
    }
    const sheetStarted = performance.now();
    await boundedRender(
      () => writeAtlasSheet(sheets, directory, batch, pngs),
      input.sheetExecution
    );
    const sheetExecutionMs = performance.now() - sheetStarted;
    for (const tile of batch)
      tile.metrics = { ...(tile.metrics as Record<string, unknown>), sheetExecutionMs };
    for (const tile of batch) tile.html += `#${tile.id}`;
    tiles.push(...batch);
  }
  return tiles;
}

interface AtlasLessonSummary {
  courseId: string;
  lessonId: string;
  blocks: number;
  preparationSha256: string;
  rendererStartupMs: { viewport: string; milliseconds: number }[];
  preparedBlocks: readonly LessonPlaybackBlock[];
  skipReason?: string;
}
interface CaptureRecords {
  lessons: AtlasLessonSummary[];
  tiles: AtlasTile[];
}

async function captureCourse(input: {
  sheets: Page;
  terminateSheets: () => Promise<void>;
  course: AtlasCourse;
  options: Options;
  scenario: AtlasScenario;
  origin: string;
  directory: string;
  records: CaptureRecords;
}) {
  const { sheets, course, options, scenario, origin, directory, records } = input;
  for (const lesson of atlasLessons(course.snapshot)) {
    if (options.lesson && lesson.id !== options.lesson) continue;
    const summary: AtlasLessonSummary = {
      courseId: lesson.projectId,
      lessonId: lesson.id,
      blocks: 0,
      preparationSha256: '',
      preparedBlocks: [],
      rendererStartupMs: [],
    };
    records.lessons.push(summary);
    for (const viewport of scenario.viewports) {
      let ownedServer: BrowserServer | undefined;
      let renderer: Browser | undefined;
      let context: BrowserContext | undefined;
      let page: Page;
      const closeRenderer = async () => {
        const current = ownedServer;
        ownedServer = undefined;
        renderer = undefined;
        context = undefined;
        await current?.kill();
      };
      const openRenderer = async () => {
        if (!renderer) {
          ownedServer = await chromium.launchServer({ headless: true });
          renderer = await chromium.connect(ownedServer.wsEndpoint());
        }
        context = await renderer.newContext(viewportOptions(viewport));
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          const assetId = /\/api\/projects\/[^/]+\/assets\/([^/]+)$/u.exec(url.pathname)?.[1];
          if (assetId) {
            const asset = course.assets.find(entry => entry.ref.id === assetId);
            await route.fulfill(
              asset
                ? { status: 200, contentType: asset.ref.mediaType, body: Buffer.from(asset.bytes) }
                : { status: 404, body: 'Asset absent from archive.' }
            );
          } else if (url.origin === origin && !url.pathname.startsWith('/api/'))
            await route.continue();
          else await route.abort('blockedbyclient');
        });
        await context.addInitScript(resetAtlasRandom);
        await context.addInitScript(installAtlasFrameClock, ATLAS_FRAME_MS);
        page = await context.newPage();
        await installAtlasClock(page);
        await installProbes(page);
        await page.goto(origin);
        await waitForAtlasEntry(page);
        const blocks = await page.evaluate(value => window.playbackAtlas.prepare(value), lesson);
        const fingerprint = createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
        if (summary.preparationSha256 && summary.preparationSha256 !== fingerprint)
          throw new Error('Playback preparation changed between renderer captures.');
        summary.blocks = blocks.length;
        if (!blocks.length)
          summary.skipReason = 'The production playback projection has no spoken blocks.';
        summary.preparationSha256 = fingerprint;
        summary.preparedBlocks = blocks;
        return { blocks, page, context };
      };
      try {
        const startup = performance.now();
        const { blocks, page: initialPage } = await boundedRender(openRenderer, {
          milliseconds: options.renderTimeoutMs,
          terminate: closeRenderer,
        });
        summary.rendererStartupMs.push({
          viewport: viewport.id,
          milliseconds: performance.now() - startup,
        });
        records.tiles.push(
          ...(await captureLesson({
            page: initialPage,
            sheets,
            directory,
            lesson,
            blocks,
            viewport,
            ordinal: records.lessons.length,
            checks: scenario.checks,
            sheetExecution: {
              milliseconds: options.renderTimeoutMs,
              terminate: input.terminateSheets,
            },
            renderSample: async sample => {
              const started = performance.now();
              const captured = await boundedRender(
                async () => {
                  const current = context ?? (await openRenderer()).context;
                  try {
                    return await captureSample(page, sample);
                  } finally {
                    if (context === current) context = undefined;
                    await current.close();
                  }
                },
                {
                  milliseconds: options.renderTimeoutMs,
                  terminate: closeRenderer,
                }
              );
              return {
                ...captured,
                metrics: { ...captured.metrics, executionMs: performance.now() - started },
              };
            },
          }))
        );
        await writeAtlasIndex(directory, records.tiles);
      } finally {
        await closeRenderer();
      }
    }
  }
}

async function resolveScenario(options: Options) {
  const declared = await readAtlasScenario(options.scenarioPath);
  let fixture = declared.fixture;
  if (options.library) fixture = { kind: 'library', path: options.library };
  else if (options.fixture) fixture = { kind: 'project', path: options.fixture };
  else if (options.synthetic) fixture = { kind: 'synthetic', generator: options.synthetic };
  const scenario = AtlasScenarioSchema.parse({ ...declared, fixture });
  if (process.env.CI && scenario.fixture.kind === 'library')
    throw new Error('Private library atlases are local-only.');
  return scenario;
}

export function atlasStatus(
  errors: readonly AtlasFinding[],
  findings: readonly AtlasFinding[],
  incomplete = false
) {
  if (errors.length || incomplete) return 'incomplete';
  return findings.length ? 'findings' : 'passed';
}

type AtlasPostcss = Exclude<NonNullable<CSSOptions['postcss']>, string>;

function atlasPostcss(sourceRoot: string): AtlasPostcss {
  const configPath = join(sourceRoot, 'apps/web/postcss.config.cjs');
  const load = createRequire(configPath);
  const configured = load(configPath) as { plugins: Record<string, Record<string, unknown>> };
  const tailwindOptions = configured.plugins.tailwindcss as { config: string };
  const tailwind = load(tailwindOptions.config) as { content: string[] };
  return {
    plugins: Object.entries(configured.plugins).map(([name, options]) => {
      const plugin = load(name) as (
        options: unknown
      ) => NonNullable<AtlasPostcss['plugins']>[number];
      const resolved =
        name === 'tailwindcss'
          ? {
              ...options,
              config: {
                ...tailwind,
                content: tailwind.content.map(file => normalizePath(join(sourceRoot, file))),
              },
            }
          : options;
      return plugin(resolved);
    }),
  };
}

async function startRenderer(options: Options, directory: string) {
  const outDir = join(directory, 'renderer');
  await build({
    configFile: join(options.sourceRoot, 'apps/web/vite.config.ts'),
    css: { postcss: atlasPostcss(options.sourceRoot) },
    root: join(REPO_ROOT, 'e2e/nous/atlas'),
    mode: 'test',
    resolve: {
      alias: {
        '@atlas-web': join(options.sourceRoot, 'apps/web'),
        '@atlas-katex.css': atlasKatexCss(options.sourceRoot),
      },
    },
    build: { outDir, emptyOutDir: false },
    logLevel: 'warn',
  });
  const server = await preview({
    configFile: false,
    root: REPO_ROOT,
    build: { outDir },
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'warn',
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('Atlas renderer address is unavailable.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClosed, reject) => {
        server.httpServer.close(error => (error ? reject(error) : resolveClosed()));
      }),
  };
}

/** Backend-free, sequential Chromium capture. The source checkout supplies production code. */
export async function runPlaybackAtlas(options: Options) {
  const scenario = await resolveScenario(options);
  const { directory, runId } = await privateAtlasDirectory(options.outputRoot, options.sourceRoot);
  const sourceSha = git(options.sourceRoot, 'rev-parse', 'HEAD');
  const sourceStatus = git(options.sourceRoot, 'status', '--porcelain');
  const toolSha = git(REPO_ROOT, 'rev-parse', 'HEAD');
  const toolDirty = Boolean(git(REPO_ROOT, 'status', '--porcelain'));
  const started = performance.now();
  const tiles: AtlasTile[] = [];
  const lessons: AtlasLessonSummary[] = [];
  const errors: AtlasFinding[] = [];
  let sheetsServer: BrowserServer | undefined;
  let server: Awaited<ReturnType<typeof startRenderer>> | undefined;
  try {
    server = await startRenderer(options, directory);
    const { origin } = server;
    const sheetsOwner = await chromium.launchServer({ headless: true });
    sheetsServer = sheetsOwner;
    const browser = await chromium.connect(sheetsOwner.wsEndpoint());
    const sheets = await browser.newPage();
    for await (const course of atlasCourses(scenario.fixture, options.course)) {
      if (options.course && course.snapshot.id !== options.course) continue;
      await captureCourse({
        sheets,
        terminateSheets: () => sheetsOwner.kill(),
        course,
        options,
        scenario,
        origin,
        directory,
        records: { lessons, tiles },
      });
    }
    if (!lessons.length) throw new Error('No lessons matched the requested input.');
    if (!tiles.length) throw new Error('The selected lessons have no playback blocks to capture.');
  } catch (error) {
    errors.push({
      kind: 'render-error',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await sheetsServer?.kill();
    await server?.close();
  }
  const findings = tiles.flatMap(tile =>
    tile.findings.map(finding => ({
      ...finding,
      tile: {
        id: tile.id,
        html: tile.html,
        image: tile.image,
        sheet: tile.sheet,
        box: tile.sheetBox,
      },
    }))
  );
  const counts = Object.fromEntries(
    [...new Set([...findings, ...errors].map(finding => finding.kind))]
      .sort((a, b) => a.localeCompare(b, 'en'))
      .map(kind => [kind, [...findings, ...errors].filter(finding => finding.kind === kind).length])
  );
  const report = {
    runId,
    scenario,
    agentReview: { status: 'pending', findings: [] },
    sourceSha,
    sourceDirty: Boolean(sourceStatus),
    toolSha,
    toolDirty,
    status: atlasStatus(
      errors,
      findings,
      tiles.some(tile => tile.incomplete) || lessons.some(lesson => !lesson.blocks)
    ),
    elapsedMs: performance.now() - started,
    lessons,
    tileCount: tiles.length,
    counts,
    findings,
    errors,
    renderTimeoutMs: options.renderTimeoutMs,
    thresholdDecisions: THRESHOLD_DECISIONS,
    tiles,
  };
  await writeAtlasIndex(directory, tiles);
  await writeAtlasArtifact(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  return { directory, report };
}

if (import.meta.main) {
  const { directory, report } = await runPlaybackAtlas(parseAtlasArgs(process.argv.slice(2)));
  console.log(
    JSON.stringify({
      directory,
      status: report.status,
      lessons: report.lessons.length,
      tiles: report.tileCount,
      counts: report.counts,
    })
  );
  process.exit(report.status === 'passed' ? 0 : 1);
}
