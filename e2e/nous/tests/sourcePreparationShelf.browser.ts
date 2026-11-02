import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourcePreparationProgress } from '@shared/sourcePreparation';
import JSZip from 'jszip';
import { getProjectImportUploadStatus } from '../../../apps/backend/src/projects/projectImportChunks';
import { unavailableCourseGenerationApi } from '../../../apps/backend/src/workflows/courseGenerationApi';
import { CourseInterviewTargetNotFoundError } from '../../../apps/backend/src/workflows/courseInterviewApi';
import { dataRoot, withMemoryProjectBrowserStack } from '../stack';

// Real upload/expansion/save and controller. Hold completed status responses to inspect
// deterministic progress scenes; backend completion ordering has its own regression.
const evidence = join(dataRoot(), 'source-preparation-shelf');
const browserName = process.env.SHELF_BROWSER ?? 'chromium';
assert(browserName === 'chromium' || browserName === 'firefox' || browserName === 'webkit');
await mkdir(evidence, { recursive: true });
const results: object[] = [];
const archive = new JSZip();
const sourceNames = [
  '01_Concetti.md',
  '02_Probabilità/Note.md',
  '03_Statistica/Note.md',
  ...Array.from({ length: 5 }, (_, index) => `${index + 4}_Approfondimento.md`),
  `8_${'Fondamenti di probabilità e statistica applicata '.repeat(3)}.md`,
];
for (const name of sourceNames)
  archive.file(name, `# ${name}\nSynthetic material for source preparation verification.`);
archive.file('Ignorato.zip', 'Excluded nested archive');
const buffer = await archive.generateAsync({ type: 'nodebuffer' });

const scenes = [
  { name: 'desktop-light', width: 1280, height: 800, dark: false, reduced: false },
  { name: 'desktop-dark', width: 1280, height: 800, dark: true, reduced: false },
  { name: 'mobile-light', width: 390, height: 844, dark: false, reduced: false },
  { name: 'mobile-dark', width: 390, height: 844, dark: true, reduced: false },
  { name: 'mobile-compact', width: 360, height: 640, dark: false, reduced: false },
  { name: 'cancel-retry', width: 390, height: 844, dark: false, reduced: true },
  { name: 'media-failure', width: 390, height: 844, dark: true, reduced: false },
] as const;

// Each Vite/Rolldown instance owns its native lifetime. Repeated teardown in one
// Windows Bun process can panic after the assertions have already passed.
if (!process.env.SHELF_SCENE) {
  for (const scene of scenes) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, SHELF_SCENE: scene.name },
      stdio: 'inherit',
    });
    assert.equal(child.status, 0, `Preparation scene failed: ${scene.name}`);
    const result = JSON.parse(await readFile(join(evidence, `result-${scene.name}.json`), 'utf8'));
    results.push(...result.results);
  }
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify({ profile: 'isolated real-app source-preparation scenes', results }, null, 2)
  );
  console.log(`Preparation shelf: ${results.length} isolated scenes passed.`);
  process.exit(0);
}
assert(
  scenes.some(scene => scene.name === process.env.SHELF_SCENE),
  'Unknown preparation scene'
);
for (const scene of scenes) {
  if (process.env.SHELF_SCENE && process.env.SHELF_SCENE !== scene.name) continue;
  const userId = `source-preparation-shelf-${scene.name}`;
  await withMemoryProjectBrowserStack(
    {
      userId,
      browserName,
      recordVideo: {
        dir: join(evidence, scene.name),
        size: { width: scene.width, height: scene.height },
      },
      appOptions: {
        courseGenerationApi: { ...unavailableCourseGenerationApi, getActive: async () => null },
        courseInterviewApi: {
          getActive: async () => null,
          start: async () => {
            throw new CourseInterviewTargetNotFoundError();
          },
        },
      },
    },
    async ({ page, url, store }) => {
      const errors: string[] = [];
      const navigations: string[] = [];
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
      });
      page.on('pageerror', error => errors.push(error.message));
      await page.context().tracing.start({ screenshots: true, snapshots: true });
      await page.setViewportSize({ width: scene.width, height: scene.height });
      await page.emulateMedia({
        colorScheme: scene.dark ? 'dark' : 'light',
        reducedMotion: scene.reduced ? 'reduce' : 'no-preference',
      });
      if (scene.name === 'media-failure')
        await page.route('**/source-shelf/*.webm', route => route.abort('failed'));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.evaluate(
        dark => localStorage.setItem('nous-ui-preferences', JSON.stringify({ isDarkMode: dark })),
        scene.dark
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      let phase:
        | 'reading'
        | 'error'
        | 'concurrent'
        | 'next'
        | 'reveal'
        | 'transcription'
        | 'saving'
        | 'release' = 'reading';
      let heldUploadId = '';
      let cancelledProjectId = '';
      let holdSave = scene.name === 'cancel-retry';
      let saveAborted = false;
      const originalSave = store.saveProject.bind(store);
      store.saveProject = async (owner, snapshot, options) => {
        if (holdSave && options?.sourcePreparation) {
          holdSave = false;
          cancelledProjectId = snapshot.id;
          const { signal } = options.sourcePreparation;
          await new Promise<never>((_resolve, reject) => {
            const abort = () => {
              saveAborted = true;
              reject(signal.reason);
            };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
        return originalSave(owner, snapshot, options);
      };
      let documents: NonNullable<SourcePreparationProgress['documents']> = [];
      let projectId = '';
      const snapshots: object[] = [];
      await page.route(/\/api\/projects\/import\/chunks\/[^/]+(?:\?.*)?$/, async route => {
        if (route.request().method() !== 'GET' || phase === 'release') return route.continue();
        const uploadId = new URL(route.request().url()).pathname.split('/').at(-1);
        assert(uploadId);
        heldUploadId = uploadId;
        const response = await route.fetch();
        const body = await response.json();
        if (!body.complete) {
          // The cancellation scene must observe the real pending save before aborting it.
          if (scene.name === 'cancel-retry' && !saveAborted) return route.fulfill({ response });
          // Keep the scripted document states monotonic while the real import finishes.
          delete body.progress;
          return route.fulfill({ json: body });
        }
        projectId = body.snapshot.id;
        const activeIndex =
          phase === 'reveal'
            ? sourceNames.length - 1
            : phase === 'next' || phase === 'transcription'
              ? 2
              : 1;
        documents = body.snapshot.source.sources.map(
          (source: { id: string; name: string }, index: number) => ({
            id: source.id,
            name: source.name,
            state:
              scene.name === 'media-failure' && phase === 'error' && index === 2
                ? 'error'
                : phase === 'saving' || index < activeIndex
                  ? 'done'
                  : index === activeIndex || (phase === 'concurrent' && index === 2)
                    ? 'reading'
                    : 'idle',
          })
        );
        const progress: SourcePreparationProgress = {
          step: phase === 'saving' ? 'persistence' : 'extraction',
          completed: phase === 'saving' ? 0 : 1,
          total: documents.length,
          documents,
          documentName: documents.find(document => document.state === 'reading')?.name,
        };
        if (phase === 'transcription') {
          progress.step = 'pdf-transcription';
          progress.completed = 165;
          progress.total = 200;
          progress.reducedQuality = { from: 151, to: 200 };
        }
        await writeFile(
          join(evidence, `${scene.name}-wire.json`),
          JSON.stringify(progress, null, 2)
        );
        await route.fulfill({ json: { success: true, uploadStatus: 'finalizing', progress } });
      });

      async function start(pendingSave = false) {
        await page.getByRole('button', { name: 'Impara un nuovo argomento', exact: true }).click();
        const chooser = page.waitForEvent('filechooser');
        await page.locator('[data-home-chat-target=attachment]').click();
        await (await chooser).setFiles([
          { name: 'Corso.zip', mimeType: 'application/zip', buffer },
        ]);
        await page.getByText('Verifica dei file…', { exact: true }).waitFor({ state: 'hidden' });
        await page
          .locator('input[data-home-chat-target=objective]')
          .fill('Imparare probabilità e statistica');
        await page.locator('input[data-home-chat-target=objective]').press('Enter');
        try {
          await page
            .getByRole('region', { name: 'Preparazione delle fonti' })
            .getByText(
              pendingSave ? 'Salvataggio fonti' : `Lettura fonti 2 di ${sourceNames.length}`,
              { exact: !pendingSave }
            )
            .waitFor();
        } catch (error) {
          await page.screenshot({
            path: join(evidence, `${scene.name}-failure.png`),
            fullPage: scene.name !== 'desktop-light',
          });
          await writeFile(join(evidence, `${scene.name}-failure.html`), await page.content());
          throw error;
        }
      }
      const startedAt = performance.now();
      await start(scene.name === 'cancel-retry');
      if (scene.name === 'cancel-retry') {
        assert.equal(getProjectImportUploadStatus(userId, heldUploadId)?.status, 'finalizing');
        const cancellation = page.waitForResponse(
          response =>
            response.request().method() === 'DELETE' && response.url().includes(heldUploadId)
        );
        await page.getByRole('button', { name: 'Annulla', exact: true }).click();
        assert((await cancellation).ok());
        await page
          .getByRole('region', { name: 'Preparazione delle fonti' })
          .waitFor({ state: 'detached' });
        assert(saveAborted, 'Stop must abort the actual pending save');
        assert.equal(await store.loadProject(userId, cancelledProjectId), null);
        assert.notEqual(getProjectImportUploadStatus(userId, heldUploadId)?.status, 'completed');
        snapshots.push({ phase: 'cancelled-pending-save', saveAborted, cancelledProjectId });
        await start();
      }
      const shelf = page.getByRole('region', { name: 'Preparazione delle fonti' });
      const books = shelf.locator('.source-shelf-item');
      assert.deepEqual(
        await books.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-state'))),
        sourceNames.map((_, index) => (index === 0 ? 'done' : index === 1 ? 'reading' : 'idle'))
      );
      assert.deepEqual(
        await books.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))),
        documents.map(document => document.name)
      );
      assert.equal(await books.nth(1).getAttribute('aria-current'), 'true');
      assert.equal(await books.first().getAttribute('aria-description'), 'Fonte letta');
      assert.equal(await shelf.getByRole('button', { name: 'Rimuovi allegato' }).count(), 0);
      assert(await shelf.getByText(/Ignorato.zip/).isVisible());
      const geometry = await shelf.evaluate(element => ({
        shelf: element.getBoundingClientRect().toJSON(),
        pageWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      assert(geometry.pageWidth <= geometry.viewport);
      const frame = await page.locator('.course-setup-stage').boundingBox();
      const stop = await page.getByRole('button', { name: 'Annulla', exact: true }).boundingBox();
      assert(
        frame &&
          stop &&
          stop.y + stop.height <= frame.y + frame.height &&
          stop.y + stop.height <= scene.height,
        `Stop is clipped by the setup frame: ${JSON.stringify({ frame, stop })}`
      );
      const motion = await books.nth(1).evaluate(element => ({
        animation: getComputedStyle(element).animationName,
        transition: getComputedStyle(element.querySelector('.source-book') as Element)
          .transitionDuration,
      }));
      if (scene.reduced) {
        assert.deepEqual(motion, { animation: 'none', transition: '0s' });
        assert.equal(await shelf.locator('video').count(), 0);
      } else if (scene.name === 'media-failure') {
        await page.waitForFunction(
          () => document.querySelectorAll('.source-shelf video').length === 0
        );
        assert(await books.nth(1).locator('img').isVisible());
      } else {
        await books.nth(1).locator('video[data-phase=search]').waitFor();
        await page.waitForFunction(() => {
          const video = document.querySelector<HTMLVideoElement>(
            '.source-shelf-item[aria-current=true] video'
          );
          return video && !video.paused && video.readyState >= 2 && video.currentTime > 0;
        });
        const playback = await shelf
          .locator('.source-shelf-item[aria-current=true] video')
          .evaluate(element => {
            const video = element as HTMLVideoElement;
            const quality = video.getVideoPlaybackQuality();
            video.dataset.playerWitness = 'same-source-player';
            return {
              phase: video.dataset.phase,
              time: video.currentTime,
              loop: video.loop,
              width: video.videoWidth,
              decoded: quality.totalVideoFrames,
              dropped: quality.droppedVideoFrames,
            };
          });
        assert.equal(playback.loop, true);
        assert.equal(playback.phase, 'search');
        assert.equal(playback.width, 512);
        snapshots.push({ phase: 'actual-native-playback', playback });
      }
      await page.waitForFunction(() => {
        const active = document.querySelector<HTMLElement>('.source-shelf-item[aria-current=true]');
        const list = active?.parentElement;
        const currentArt = active?.querySelector<HTMLElement>('.source-book');
        const otherArt = list?.querySelector<HTMLElement>(
          '.source-shelf-item[data-state=done] .source-book'
        );
        if (!active || !list || !currentArt || !otherArt) return false;
        const book = active.getBoundingClientRect();
        const viewport = list.getBoundingClientRect();
        return (
          Math.abs((book.left + book.right - viewport.left - viewport.right) / 2) <= 2 &&
          currentArt.getBoundingClientRect().width > otherArt.getBoundingClientRect().width
        );
      });
      const ordinal = shelf.getByText(`Lettura fonti 2 di ${sourceNames.length}`, { exact: true });
      assert.equal(await ordinal.getAttribute('class'), 'sr-only');
      await page.screenshot({ path: join(evidence, `${scene.name}-reading.png`), fullPage: false });
      snapshots.push({ phase, documents, geometry, motion });
      assert(
        await page
          .locator('header')
          .getByText(`${sourceNames.length} fonti`, { exact: true })
          .isVisible()
      );
      const stage = books.nth(1);
      assert.equal(await stage.getAttribute('data-source-key'), documents[1].id);
      assert.equal(await stage.getAttribute('data-palette'), 'copper');
      if (scene.reduced || scene.name === 'media-failure') {
        assert.equal(await shelf.locator('video').count(), 0);
      } else {
        assert.equal(await books.nth(1).locator('video').count(), 1);
        for (const video of await shelf.locator('video').all()) {
          const owner = video.locator('xpath=ancestor::li[1]');
          if ((await owner.getAttribute('data-state')) === 'done')
            assert.equal(await video.getAttribute('loop'), null, 'Completed book must not loop');
        }
      }
      assert.equal(await books.first().getAttribute('data-palette'), 'blue');
      assert.equal(await books.nth(2).getAttribute('data-palette'), 'sage');
      await books.first().focus();
      await page.keyboard.press('ArrowRight');
      assert(await books.nth(1).evaluate(element => element === document.activeElement));
      phase = 'error';
      if (scene.name === 'media-failure') {
        await books.nth(2).locator('.source-book-error').waitFor();
        assert.equal(await books.nth(2).getAttribute('aria-description'), 'Fonte non utilizzabile');
        await page.screenshot({ path: join(evidence, `${scene.name}-error.png`) });
      }
      assert.equal(await books.first().getAttribute('aria-description'), 'Fonte letta');
      assert(await books.first().locator('.source-book-done').isVisible());
      snapshots.push({ phase, documents });
      if (!scene.reduced && scene.name !== 'media-failure')
        assert.equal(
          await stage.locator('video').getAttribute('data-player-witness'),
          'same-source-player',
          'Polling remounted the active player'
        );
      phase = 'concurrent';
      await page.waitForFunction(
        () =>
          document.querySelectorAll('.source-shelf-item')[2]?.getAttribute('data-state') ===
          'reading'
      );
      assert.equal(await books.nth(1).getAttribute('aria-current'), 'true');
      assert.equal(await books.nth(2).getAttribute('aria-current'), null);
      assert.equal(await books.nth(2).locator('video').count(), 0);
      snapshots.push({ phase, documents });
      phase = 'next';
      await page.waitForFunction(
        () =>
          document.querySelectorAll('.source-shelf-item')[2]?.getAttribute('aria-current') ===
          'true'
      );
      if (!scene.reduced && scene.name !== 'media-failure') {
        const closing = books.nth(1).locator('video[data-phase=complete]');
        await closing.waitFor();
        assert.equal(await closing.getAttribute('loop'), null);
        await page.waitForFunction(() => {
          const video = document.querySelector<HTMLVideoElement>(
            '.source-shelf-item[data-state=done] video[data-phase=complete]'
          );
          return video && !video.paused && video.currentTime > 0;
        });
      }
      assert(
        await books.nth(1).evaluate(element => element === document.activeElement),
        'Reading progress moved keyboard focus'
      );
      await page.getByRole('button', { name: 'Annulla', exact: true }).focus();
      await page.screenshot({ path: join(evidence, `${scene.name}-next.png`) });
      snapshots.push({ phase, documents });
      phase = 'transcription';
      await shelf.getByText(/165\/200/).waitFor();
      assert(await shelf.getByText(/Pagine 151–200 trascritte in qualità ridotta/).isVisible());
      const verticalOverflow = await shelf.evaluate(
        element => element.scrollHeight > element.clientHeight
      );
      assert.equal(
        verticalOverflow,
        false,
        'Source card content should fit without vertical scrolling'
      );
      const detailBounds = await shelf.getByText(/165\/200/).boundingBox();
      const shelfBounds = await shelf.boundingBox();
      assert(
        detailBounds &&
          shelfBounds &&
          detailBounds.y >= shelfBounds.y &&
          detailBounds.y + detailBounds.height <= shelfBounds.y + shelfBounds.height,
        'PDF disclosure scrolled outside the source card'
      );
      assert.match(
        (await shelf.getByRole('status').textContent()) ?? '',
        new RegExp(`Lettura fonti 3 di ${sourceNames.length}`)
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const transcriptionFrame = await page.locator('.course-setup-stage').boundingBox();
      const transcriptionStop = await page
        .getByRole('button', { name: 'Annulla', exact: true })
        .boundingBox();
      assert(
        transcriptionFrame &&
          transcriptionStop &&
          transcriptionStop.y + transcriptionStop.height <=
            transcriptionFrame.y + transcriptionFrame.height &&
          transcriptionStop.y + transcriptionStop.height <= scene.height,
        `PDF detail clips Stop: ${JSON.stringify({ transcriptionFrame, transcriptionStop })}`
      );
      await page.waitForFunction(() => {
        const book = document.querySelector('.source-shelf-item[aria-current=true]');
        const list = book?.parentElement;
        if (!book || !list) return false;
        const bounds = book.getBoundingClientRect();
        const viewport = list.getBoundingClientRect();
        return Math.abs((bounds.left + bounds.right - viewport.left - viewport.right) / 2) <= 2;
      });
      await page.screenshot({
        path: join(evidence, `${scene.name}-transcription.png`),
        fullPage: false,
      });
      snapshots.push({ phase, documents });
      if (!scene.reduced && scene.name !== 'media-failure')
        await page.waitForFunction(() => {
          const video = document.querySelector<HTMLVideoElement>(
            '.source-shelf-item[aria-current=true] video'
          );
          return video && !video.paused && video.readyState >= 2;
        });
      phase = 'reveal';
      await books.last().locator('[aria-hidden=true]').first().waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('.source-shelf-item:last-child')?.getAttribute('aria-current') ===
          'true'
      );
      await page.waitForFunction(() => {
        const book = document.querySelector('.source-shelf-item:last-child');
        const list = book?.parentElement;
        if (!book || !list) return false;
        const bounds = book.getBoundingClientRect();
        const viewport = list.getBoundingClientRect();
        return Math.abs((bounds.left + bounds.right - viewport.left - viewport.right) / 2) <= 2;
      });
      const reveal = await books.last().evaluate(element => {
        const book = element.getBoundingClientRect();
        const parent = element.parentElement;
        if (!parent) throw new Error('Book is detached from its shelf');
        const list = parent.getBoundingClientRect();
        return {
          visible: Math.abs((book.left + book.right - list.left - list.right) / 2) <= 2,
          focused: document.activeElement?.getAttribute('data-home-chat-target'),
        };
      });
      assert(reveal.visible, 'Newly reading book remains outside the shelf viewport');
      assert.equal(reveal.focused, 'submit', 'Reading progress moved keyboard focus');
      await page.screenshot({ path: join(evidence, `${scene.name}-reveal.png`) });
      const caption = await books
        .last()
        .locator('.source-book-title')
        .evaluate(element => ({
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          clamp: getComputedStyle(element).webkitLineClamp,
          text: element.textContent,
        }));
      assert(caption.height <= 12 * 1.4 + 1);
      assert.equal(await books.last().getAttribute('title'), sourceNames.at(-1));
      assert.equal(await books.last().getAttribute('data-source-key'), documents.at(-1)?.id);
      const clippedTitle = await books
        .last()
        .locator('.source-book-title')
        .evaluate(element => ({
          whiteSpace: getComputedStyle(element).whiteSpace,
          overflow: getComputedStyle(element).textOverflow,
          clipped: element.scrollWidth > element.clientWidth,
        }));
      assert.deepEqual(clippedTitle, { whiteSpace: 'nowrap', overflow: 'ellipsis', clipped: true });
      snapshots.push({ phase, documents, reveal, caption, clippedTitle });
      phase = 'saving';
      await shelf.getByText(/Salvataggio fonti/).waitFor();
      try {
        await page.waitForFunction(() => {
          const books = [...document.querySelectorAll('.source-shelf-item')];
          return (
            books.length > 0 && books.every(book => book.getAttribute('data-state') === 'done')
          );
        });
      } catch (error) {
        console.error(
          'Saving source states:',
          await books.evaluateAll(nodes =>
            nodes.map(node => ({
              key: node.getAttribute('data-source-key'),
              state: node.getAttribute('data-state'),
            }))
          )
        );
        throw error;
      }
      assert.deepEqual(
        await books.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-state'))),
        sourceNames.map(() => 'done')
      );
      await page.screenshot({ path: join(evidence, `${scene.name}-saving.png`), fullPage: false });
      try {
        await page.waitForFunction(
          () => document.querySelectorAll('.source-shelf video').length === 0
        );
      } catch (error) {
        console.log(
          'Unsettled players',
          await shelf.locator('video').evaluateAll(nodes =>
            nodes.map(element => {
              const node = element as HTMLVideoElement;
              return {
                src: node.currentSrc,
                time: node.currentTime,
                paused: node.paused,
                ended: node.ended,
                ready: node.readyState,
                phase: node.dataset.phase,
                state: node.closest('li')?.dataset.state,
              };
            })
          )
        );
        throw error;
      }
      snapshots.push({ phase, documents });
      phase = 'release';
      await page
        .getByText('L’intervista per il corso non è riuscita. Riprova.', { exact: false })
        .waitFor();
      await shelf.waitFor({ state: 'detached' });
      const stored = await store.loadProject(userId, projectId);
      assert(stored?.source);
      const sources = await store.loadProjectSources(userId, projectId);
      assert.equal(sources.length, sourceNames.length);
      assert.deepEqual(
        sources.map(source => source.ref.id),
        documents.map(document => document.id)
      );
      assert(sources.every(source => source.file.data.length > 0));
      await page.screenshot({
        path: join(evidence, `${scene.name}-terminal.png`),
        fullPage: false,
      });
      assert.deepEqual(errors, []);
      assert.equal(navigations.length, 2, 'Unexpected navigation/reload during the recorded flow');
      await page.context().tracing.stop({ path: join(evidence, `${scene.name}-trace.zip`) });
      const video = page.video();
      if (video) {
        await page.close();
        await video.saveAs(join(evidence, `${scene.name}.webm`));
      }
      results.push({
        scene,
        browserName,
        durationMs: performance.now() - startedAt,
        snapshots,
        projectId,
        storedSourceCount: sources.length,
        pageErrors: errors,
      });
    }
  );
}
await writeFile(
  join(
    evidence,
    process.env.SHELF_SCENE ? `result-${process.env.SHELF_SCENE}.json` : 'result.json'
  ),
  JSON.stringify(
    {
      profile:
        'real app/upload/ZIP/save; controlled completed-status wire progress; deterministic terminal interview failure',
      results,
    },
    null,
    2
  )
);
console.log(
  `Preparation shelf: ${results.length} scenes passed; keyboard, reduced motion and terminal source retention verified.`
);
