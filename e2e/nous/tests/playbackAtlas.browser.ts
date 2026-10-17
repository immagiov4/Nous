import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { normalizeStoredProject } from '../../../apps/web/services/projects/projectSnapshot';
import { VIEWPORTS } from '../../../packages/playtest/src/operator/viewports';
import { visualFindings } from '../atlas/checks';
import { inspectAtlasDom } from '../atlas/dom';
import { DEFAULT_PLAYBACK_SCENARIO } from '../atlas/scenario';
import { syntheticScene } from '../atlas/synthetic';
import type { runPlaybackAtlas } from '../playbackAtlas';
import { syntheticCourse } from '../syntheticCourse';

async function runAtlas(args: string[]): Promise<Awaited<ReturnType<typeof runPlaybackAtlas>>> {
  const child = Bun.spawn([process.execPath, 'run', 'e2e/nous/playbackAtlas.ts', ...args], {
    cwd: resolve(import.meta.dirname, '../../..'),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const lastLine = stdout.trim().split('\n').at(-1);
  assert(lastLine && (code === 0 || code === 1), stderr);
  const summary = JSON.parse(lastLine) as { directory: string };
  const report = JSON.parse(await readFile(join(summary.directory, 'report.json'), 'utf8'));
  return { directory: summary.directory, report };
}

/** Explicit browser contract run; standalone so it uses the harness's waits, not a new test timeout. */
if (import.meta.main) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nous-atlas-browser-')));
  assert.equal(dirname(root), await realpath(tmpdir()));
  const input = join(root, 'project.json');
  const scenarioPath = join(root, 'scenario.json');
  await writeFile(
    scenarioPath,
    JSON.stringify({
      ...DEFAULT_PLAYBACK_SCENARIO,
      id: 'playback-browser-contract',
      viewports: [DEFAULT_PLAYBACK_SCENARIO.viewports[0]],
      fixture: { kind: 'project', path: input },
    })
  );
  try {
    const snapshot = normalizeStoredProject(syntheticCourse());
    const lesson = snapshot.learningPlan?.modules[0].children[0];
    assert(lesson?.kind === 'lesson');
    lesson.content = 'Three concepts are shown: First, Second and Third.';
    lesson.contentBlocks = [
      { type: 'markdown', markdown: lesson.content },
      { type: 'generated-visual', slotId: 'scene-slot', visualId: 'scene' },
    ];
    lesson.generatedVisuals = [
      {
        id: 'scene',
        slotId: 'scene-slot',
        createdAt: new Date(0).toISOString(),
        render: { kind: 'scene', scene: syntheticScene('definition') },
      },
    ];
    await writeFile(input, JSON.stringify(snapshot));
    const args = [
      '--scenario',
      scenarioPath,
      ...(process.argv[2] ? ['--source-root', process.argv[2]] : []),
    ];
    const positive = await runAtlas(args);
    assert.equal(positive.report.status, 'passed', JSON.stringify(positive.report.counts));
    assert(positive.report.tiles.every(tile => !tile.incomplete));
    assert(positive.report.tiles.some(tile => tile.position === 'middle'));
    const settled = await runAtlas(args);
    assert.equal(settled.report.status, 'passed');
    assert.equal(settled.report.tileCount, positive.report.tileCount);
    for (const tile of positive.report.tiles) {
      assert.deepEqual(
        await readFile(join(positive.directory, tile.image)),
        await readFile(join(settled.directory, tile.image)),
        tile.id
      );
    }

    lesson.generatedVisuals = [
      {
        id: 'scene',
        kind: 'html',
        title: 'Overflow contract',
        createdAt: new Date(0).toISOString(),
        code: '<style>@keyframes move{from{left:0}to{left:100vw}}html,body{overflow:visible!important;width:calc(100vw + 100vw)!important;height:100vh!important}</style><p style="position:absolute;animation:move 1s linear both paused;white-space:nowrap">Synthetic content outside the iframe viewport.</p>',
      },
    ];
    await writeFile(input, JSON.stringify(snapshot));
    const negative = await runAtlas(args);
    assert(
      negative.report.findings.some(
        finding =>
          finding.kind === 'visual-clipped' &&
          (finding.detail as { ancestor: string }).ancestor === 'viewport'
      ),
      'The iframe viewport must clip its offscreen content.'
    );
    assert.equal(negative.report.status, 'findings');
    assert.equal(negative.report.errors.length, 0);
    assert(
      negative.report.tiles.some(tile => {
        const metrics = tile.metrics as { frameGeometry?: { minFontPx: number | null }[] };
        return metrics.frameGeometry?.some(frame => frame.minFontPx !== null);
      }),
      'Typography must include the embedded document.'
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
      await page.setContent(
        `<div class="listening-stage" style="width:${VIEWPORTS.mobile.width}px;height:${VIEWPORTS.mobile.height}px;overflow:hidden"><div class="scene-host"><iframe style="width:${VIEWPORTS.desktop.width}px;height:${VIEWPORTS.mobile.height}px" srcdoc="<p>Contained in the inner viewport.</p>"></iframe></div></div>`
      );
      const facts = await page.evaluate(inspectAtlasDom, '.scene-host');
      assert(
        facts.clips.some(clip => clip.text === 'iframe'),
        'The outer stage must clip its oversized iframe.'
      );
      await page.setContent(
        '<div class="scene-host"><svg width="100" height="100"></svg><canvas width="100" height="100"></canvas></div>'
      );
      const blank = await page.evaluate(inspectAtlasDom, '.scene-host');
      assert.deepEqual(
        visualFindings(blank, 'Active speech.', true).map(finding => finding.kind),
        ['visual-empty']
      );
      await page.locator('svg').evaluate(element => {
        element.innerHTML = '<circle cx="50" cy="50" r="25" />';
      });
      const drawn = await page.evaluate(inspectAtlasDom, '.scene-host');
      assert.equal(drawn.mediaCount, 1);
      assert.deepEqual(visualFindings(drawn, 'Active speech.', true), []);
    } finally {
      await browser.close();
    }

    console.log(
      JSON.stringify({
        positive: positive.directory,
        repeated: settled.directory,
        clipped: negative.directory,
        identicalPixels: true,
        positiveCounts: positive.report.counts,
        clippedCounts: negative.report.counts,
      })
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
