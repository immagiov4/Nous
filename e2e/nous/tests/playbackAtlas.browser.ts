import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createProjectArchiveBlob } from '../../../apps/web/services/projects/projectArchive';
import { normalizeStoredProject } from '../../../apps/web/services/projects/projectSnapshot';
import { VIEWPORTS } from '../../../packages/playtest/src/operator/viewports';
import { visualFindings } from '../atlas/checks';
import { inspectAtlasDom } from '../atlas/dom';
import { DEFAULT_PLAYBACK_SCENARIO } from '../atlas/scenario';
import { syntheticScene } from '../atlas/synthetic';
import type { runPlaybackAtlas } from '../playbackAtlas';
import { syntheticCourse } from '../syntheticCourse';

async function runAtlas(args: string[]): Promise<Awaited<ReturnType<typeof runPlaybackAtlas>>> {
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      'e2e/nous/playbackAtlas.ts',
      '--render-timeout-ms',
      '120000',
      ...args,
    ],
    {
      cwd: resolve(import.meta.dirname, '../../..'),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
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
      ...process.argv.slice(3),
    ];
    const positive = await runAtlas(args);
    assert.equal(positive.report.status, 'passed', JSON.stringify(positive.report.counts));
    assert(positive.report.tiles.every(tile => !tile.incomplete));
    assert(positive.report.tiles.every(tile => tile.speech === lesson.content));
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
        kind: 'mermaid',
        title: 'Cold Mermaid module contract',
        createdAt: new Date(0).toISOString(),
        code: 'flowchart LR\nA[First] --> B[Second]',
      },
      {
        id: 'script-after-diagram',
        kind: 'html',
        title: 'Clock after a cold diagram',
        createdAt: new Date(0).toISOString(),
        code: `<p id="initial"></p><p id="tick"></p><script>
          document.getElementById('initial').textContent = [Date.now(), performance.now(), Math.random()].join(' / ');
          let frames = 0; const tick = stamp => { document.getElementById('tick').textContent = [performance.now(), stamp, ++frames].join(' / '); requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        </script>`,
      },
    ];
    await writeFile(input, JSON.stringify(snapshot));
    const diagram = await runAtlas(args);
    const repeatedDiagram = await runAtlas(args);
    assert.equal(diagram.report.status, 'passed', JSON.stringify(diagram.report.counts));
    assert.equal(repeatedDiagram.report.status, 'passed');
    for (const tile of diagram.report.tiles) {
      assert(!tile.incomplete, tile.id);
      assert.deepEqual(
        await readFile(join(diagram.directory, tile.image)),
        await readFile(join(repeatedDiagram.directory, tile.image)),
        `Cold Mermaid: ${tile.id}`
      );
    }

    lesson.generatedVisuals = [
      {
        id: 'scene',
        kind: 'html',
        title: 'Script determinism contract',
        createdAt: new Date(0).toISOString(),
        code: `<p id="clock">Clock</p><p id="timer">Waiting</p><p id="frame">Waiting</p><script>
        const initial = [Date.now(), Math.random(), performance.now()].join(' / ');
        document.getElementById('clock').textContent = 'Clock ' + initial;
        setTimeout(() => {document.getElementById('timer').textContent = 'Timer ' + Date.now();}, 0);
        const tick = () => {document.getElementById('frame').textContent = 'Frame ' + performance.now(); requestAnimationFrame(tick);};
        requestAnimationFrame(tick);
      </script>`,
      },
    ];
    await writeFile(input, JSON.stringify(snapshot));
    const scripted = await runAtlas(args);
    const scriptedAgain = await runAtlas(args);
    assert.equal(scripted.report.status, 'passed', JSON.stringify(scripted.report.counts));
    assert.equal(
      scriptedAgain.report.status,
      'passed',
      JSON.stringify(scriptedAgain.report.counts)
    );
    for (const tile of scripted.report.tiles) {
      assert.deepEqual(
        await readFile(join(scripted.directory, tile.image)),
        await readFile(join(scriptedAgain.directory, tile.image)),
        `Script clock/randomness: ${tile.id}`
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
    lesson.content = 'The value $x$ or $y$: example.';
    lesson.contentBlocks = [{ type: 'markdown', markdown: lesson.content }];
    lesson.generatedVisuals = [];
    await writeFile(input, JSON.stringify(snapshot));
    const missingMath = await runAtlas(args);
    assert(
      missingMath.report.findings.some(finding => finding.kind === 'speech-inline-math-omitted')
    );
    assert(missingMath.report.tiles.every(tile => tile.speech === 'The value  or : example.'));
    assert(
      missingMath.report.tiles.some(tile => {
        const metrics = tile.metrics as { speechPunctuationTokens: { text: string }[] };
        return metrics.speechPunctuationTokens.some(token => token.text === ':');
      })
    );
    lesson.content = 'A blocked visual is followed by a healthy visual.';
    lesson.contentBlocks = [
      { type: 'markdown', markdown: lesson.content },
      { type: 'generated-visual', slotId: 'hung-slot', visualId: 'hung' },
      { type: 'generated-visual', slotId: 'healthy-slot', visualId: 'healthy' },
    ];
    lesson.generatedVisuals = [
      {
        id: 'hung',
        kind: 'html',
        title: 'Nonterminating script',
        createdAt: new Date(0).toISOString(),
        code: '<script>while(true) {}</script>',
      },
      {
        id: 'healthy',
        kind: 'html',
        title: 'Healthy successor',
        createdAt: new Date(0).toISOString(),
        code: '<p>Healthy successor renders after owned-process termination.</p>',
      },
    ];
    await writeFile(input, JSON.stringify(snapshot));
    const terminated = await runAtlas(args);
    assert.equal(terminated.report.status, 'incomplete');
    assert(
      terminated.report.tiles.some(
        tile =>
          tile.incomplete &&
          tile.findings.some(
            finding =>
              finding.kind === 'render-error' && String(finding.detail).includes('terminated')
          )
      )
    );
    assert(
      terminated.report.tiles.some(tile => tile.visualIndex === 1 && !tile.incomplete),
      'A fresh renderer must capture the healthy successor.'
    );
    assert(terminated.report.tiles.every(tile => tile.speech === lesson.content));
    lesson.generatedVisuals = [];
    const imageBytes = await readFile(
      new URL('../../../packages/playtest/tests/fixtures/images/first.png', import.meta.url)
    );
    const hash = createHash('sha256').update(imageBytes).digest('hex');
    const asset = { id: hash, hash, byteSize: imageBytes.length, mediaType: 'image/png' } as const;
    snapshot.documentAssets = {
      kind: 'pdf',
      parsedAt: new Date(0).toISOString(),
      imageCount: 1,
      usedImages: [
        {
          id: 'archive-pdf',
          asset,
          sourceOrder: 1,
          textBefore: '',
          textAfter: '',
        },
      ],
    };
    lesson.content =
      'An archived figure accompanies this explanation.\n\n{{PDF_IMAGE:archive-pdf|alt=Synthetic archive image}}';
    lesson.contentBlocks = [{ type: 'markdown', markdown: lesson.content }];
    lesson.imageRefs = [{ assetId: 'archive-pdf', alt: 'Synthetic archive image' }];
    const archive = await createProjectArchiveBlob(snapshot, { loadAsset: async () => imageBytes });
    const archivePath = join(root, 'project.nous.zip');
    await writeFile(archivePath, new Uint8Array(await archive.arrayBuffer()));
    const archiveRun = await runAtlas([...args, '--fixture', archivePath]);
    assert.equal(archiveRun.report.errors.length, 0, JSON.stringify(archiveRun.report.errors));
    assert(archiveRun.report.tiles.every(tile => !tile.incomplete));
    assert(
      archiveRun.report.tiles.some(tile => (tile.metrics as { mediaCount: number }).mediaCount > 0),
      'The archive-backed PDF image must be decoded before capture.'
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
      await page.locator('svg').evaluate(element => {
        element.style.overflow = 'hidden';
        element.innerHTML = '<circle cx="100" cy="50" r="40" />';
      });
      const clippedGraphic = await page.evaluate(inspectAtlasDom, '.scene-host');
      assert(
        clippedGraphic.clips.some(
          clip => clip.text === 'circle' && clip.box.right > clip.boundary.right
        ),
        'A graphic clipped inside its SVG must be reported.'
      );
    } finally {
      await browser.close();
    }

    console.log(
      JSON.stringify({
        positive: positive.directory,
        repeated: settled.directory,
        coldMermaid: diagram.directory,
        repeatedMermaid: repeatedDiagram.directory,
        clipped: negative.directory,
        missingMath: missingMath.directory,
        scripted: scripted.directory,
        repeatedScripted: scriptedAgain.directory,
        archivePdf: archiveRun.directory,
        terminatedScript: terminated.directory,
        identicalPixels: true,
        positiveCounts: positive.report.counts,
        clippedCounts: negative.report.counts,
      })
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
