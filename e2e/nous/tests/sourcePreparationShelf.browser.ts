import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourcePreparationProgress } from '@shared/sourcePreparation';
import JSZip from 'jszip';
import { getProjectImportUploadStatus } from '../../../apps/backend/src/projects/projectImportChunks';
import { unavailableCourseGenerationApi } from '../../../apps/backend/src/workflows/courseGenerationApi';
import { CourseInterviewTargetNotFoundError } from '../../../apps/backend/src/workflows/courseInterviewApi';
import { dataRoot, withMemoryProjectBrowserStack } from '../stack';

// Real upload/expansion/save and controller. Hold completed status responses to inspect
// deterministic progress scenes; backend completion ordering has its own regression.
const evidence = join(dataRoot(), 'source-preparation-shelf');
await mkdir(evidence, { recursive: true });
const results: object[] = [];
const archive = new JSZip();
const sourceNames = [
  '01_Concetti.md',
  '02_Probabilità/Note.md',
  '03_Statistica/Note.md',
  ...Array.from({ length: 5 }, (_, index) => `${index + 4}_Approfondimento.md`),
];
for (const name of sourceNames)
  archive.file(name, `# ${name}\nSynthetic material for source preparation verification.`);
archive.file('Ignorato.zip', 'Excluded nested archive');
const buffer = await archive.generateAsync({ type: 'nodebuffer' });

for (const scene of [
  { name: 'desktop-light', width: 1280, height: 800, dark: false },
  { name: 'desktop-dark', width: 1280, height: 800, dark: true },
  { name: 'mobile-light', width: 390, height: 844, dark: false },
  { name: 'mobile-dark', width: 390, height: 844, dark: true },
  { name: 'cancel-retry', width: 390, height: 844, dark: false },
]) {
  if (process.env.SHELF_SCENE && process.env.SHELF_SCENE !== scene.name) continue;
  const userId = `source-preparation-shelf-${scene.name}`;
  await withMemoryProjectBrowserStack(
    {
      userId,
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
      page.on('pageerror', error => errors.push(error.message));
      await page.context().tracing.start({ screenshots: true, snapshots: true });
      await page.setViewportSize({ width: scene.width, height: scene.height });
      await page.emulateMedia({
        colorScheme: scene.dark ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.evaluate(
        dark => localStorage.setItem('nous-ui-preferences', JSON.stringify({ isDarkMode: dark })),
        scene.dark
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      let phase: 'reading' | 'error' | 'reveal' | 'transcription' | 'saving' | 'release' =
        'reading';
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
        if (!body.complete) return route.fulfill({ response });
        projectId = body.snapshot.id;
        documents = body.snapshot.source.sources.map(
          (source: { id: string; name: string }, index: number) => ({
            id: source.id,
            name: source.name,
            state:
              phase === 'error' && index === 0
                ? 'error'
                : phase === 'saving' || index === 0
                  ? 'done'
                  : index === (phase === 'reveal' ? sourceNames.length - 1 : 1)
                    ? 'reading'
                    : 'idle',
          })
        );
        const progress: SourcePreparationProgress = {
          step: phase === 'saving' ? 'persistence' : 'extraction',
          completed: phase === 'saving' ? 0 : 1,
          total: documents.length,
          documents,
          documentName: documents[1]?.name,
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
      await books.first().focus();
      await page.keyboard.press('ArrowRight');
      assert(await books.nth(1).evaluate(element => element === document.activeElement));
      const geometry = await shelf.evaluate(element => ({
        shelf: element.getBoundingClientRect().toJSON(),
        pageWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      assert(geometry.pageWidth <= geometry.viewport);
      const frame = await page.locator('.course-setup-stage').boundingBox();
      const stop = await page.getByRole('button', { name: 'Annulla', exact: true }).boundingBox();
      assert(
        frame && stop && stop.y + stop.height <= frame.y + frame.height,
        'Stop is clipped by the setup frame'
      );
      const motion = await books.nth(1).evaluate(element => ({
        animation: getComputedStyle(element).animationName,
        transition: getComputedStyle(element.querySelector('.source-book') as Element)
          .transitionDuration,
      }));
      assert.deepEqual(motion, { animation: 'none', transition: '0s' });
      await page.screenshot({ path: join(evidence, `${scene.name}-reading.png`), fullPage: false });
      snapshots.push({ phase, documents, geometry, motion });
      assert(
        await page
          .locator('header')
          .getByText(`${sourceNames.length} fonti`, { exact: true })
          .isVisible()
      );
      phase = 'error';
      await books.first().locator('.source-book-error').waitFor();
      assert.equal(await books.first().getAttribute('aria-description'), 'Fonte non utilizzabile');
      await page.screenshot({ path: join(evidence, `${scene.name}-error.png`) });
      snapshots.push({ phase, documents });
      phase = 'reveal';
      await books.last().locator('[aria-hidden=true]').first().waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('.source-shelf-item:last-child')?.getAttribute('aria-current') ===
          'true'
      );
      const reveal = await books.last().evaluate(element => {
        const book = element.getBoundingClientRect();
        const parent = element.parentElement;
        if (!parent) throw new Error('Book is detached from its shelf');
        const list = parent.getBoundingClientRect();
        return {
          visible: book.left >= list.left - 1 && book.right <= list.right + 1,
          focused: document.activeElement?.getAttribute('aria-label'),
        };
      });
      assert(reveal.visible, 'Newly reading book remains outside the shelf viewport');
      assert.equal(reveal.focused, documents[1].name, 'Reading progress moved keyboard focus');
      await page.screenshot({ path: join(evidence, `${scene.name}-reveal.png`) });
      snapshots.push({ phase, documents, reveal });
      phase = 'transcription';
      await shelf.getByText(/165\/200/).waitFor();
      assert(await shelf.getByText(/Pagine 151–200 trascritte in qualità ridotta/).isVisible());
      assert.match(
        await shelf.getByRole('status').innerText(),
        new RegExp(`Lettura fonti 2 di ${sourceNames.length}`)
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
            transcriptionFrame.y + transcriptionFrame.height,
        'PDF detail clips Stop'
      );
      await page.screenshot({
        path: join(evidence, `${scene.name}-transcription.png`),
        fullPage: false,
      });
      snapshots.push({ phase, documents });
      phase = 'saving';
      await shelf.getByText(/Salvataggio fonti/).waitFor();
      assert.deepEqual(
        await books.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-state'))),
        sourceNames.map(() => 'done')
      );
      await page.screenshot({ path: join(evidence, `${scene.name}-saving.png`), fullPage: false });
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
      await page.context().tracing.stop({ path: join(evidence, `${scene.name}-trace.zip`) });
      const video = page.video();
      if (video) {
        await page.close();
        await video.saveAs(join(evidence, `${scene.name}.webm`));
      }
      results.push({
        scene,
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
