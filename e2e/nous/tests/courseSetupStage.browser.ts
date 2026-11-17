import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unavailableCourseGenerationApi } from '../../../apps/backend/src/workflows/courseGenerationApi';
import { dataRoot, withMemoryProjectBrowserStack } from '../stack';

// Real app, storage and controller; deterministic interview wire responses replace AI only.
const evidence = join(dataRoot(), 'course-setup-stage');
await mkdir(evidence, { recursive: true });
const errors: string[] = [];
const results: unknown[] = [];
for (const mobile of process.env.SETUP_MOBILE ? [true] : [false, true]) {
  for (const dark of [false, true]) {
    const scene = `${mobile ? 'mobile' : 'desktop'}-${dark ? 'dark' : 'light'}`;
    if (process.env.SETUP_SCENE && process.env.SETUP_SCENE !== scene) continue;
    await withMemoryProjectBrowserStack(
      {
        userId: 'setup-stage-user',
        recordVideo: {
          dir: evidence,
          size: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        },
        appOptions: {
          courseGenerationApi: { ...unavailableCourseGenerationApi, getActive: async () => null },
        },
      },
      async ({ page, url }) => {
        const recordingStarted = performance.now();
        page.on('pageerror', error => errors.push(error.message));
        assert.deepEqual(await page.context().storageState(), { cookies: [], origins: [] });
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const started = performance.now();
        await page.setViewportSize(
          mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }
        );
        await page.emulateMedia({
          colorScheme: dark ? 'dark' : 'light',
          reducedMotion: mobile ? 'reduce' : 'no-preference',
        });
        await page.evaluate(
          isDark =>
            localStorage.setItem('nous-ui-preferences', JSON.stringify({ isDarkMode: isDark })),
          dark
        );
        let projectId = '';
        let phase: 'goal' | 'preferences' | 'knowledge' | 'plan' | 'cancelled' = 'goal';
        const answerGate = Promise.withResolvers<void>();
        let approval: unknown;
        let cancellations = 0;
        const timestamp = '2026-11-01T12:00:00.000Z';
        const run = () => ({
          id: 'setup-run',
          projectId,
          status: 'waiting',
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const event = (eventType: string, payload: unknown, sequence: string) => ({
          eventType,
          payload,
          sequence,
          schemaVersion: 1,
          createdAt: timestamp,
        });
        await page.route('**/api/course-interviews**', async route => {
          if (route.request().method() === 'POST') {
            projectId = route.request().postDataJSON().projectId;
            await route.fulfill({ json: { success: true, run: run() } });
          } else
            await route.fulfill(
              projectId ? { json: { success: true, run: run() } } : { status: 404, json: {} }
            );
        });
        await page.route('**/api/workflows/runs/setup-run**', async route => {
          const request = route.request();
          if (request.url().endsWith('/cancellation')) {
            cancellations++;
            phase = 'cancelled';
            await route.fulfill({ json: { success: true } });
            return;
          }
          if (request.method() === 'POST') {
            const signal = request.postDataJSON();
            if (signal.signalType === 'user-answer') {
              await answerGate.promise;
              phase = 'preferences';
            } else if (signal.signalType === 'course-decision') {
              approval = signal.payload;
              phase = 'knowledge';
            } else phase = 'plan';
            await route.fulfill({ json: { success: true } });
            return;
          }
          const events = [
            event(
              'course-interview-message',
              { message: { role: 'user', text: 'Vorrei imparare la statistica per informatica.' } },
              '1'
            ),
            event(
              'course-interview-message',
              {
                message: {
                  role: 'model',
                  text: 'Quale obiettivo vorresti raggiungere con questo corso?',
                },
              },
              '2'
            ),
          ];
          if (phase === 'preferences' || phase === 'knowledge' || phase === 'plan')
            events.push(
              event(
                'course-proposal-ready',
                {
                  supportsCoursePreferences: true,
                  proposal: {
                    context: 'Università',
                    experienceLevel: 'Principiante',
                    goals: 'Capire probabilità e statistica',
                    language: 'Italiano',
                    learningStyle: 'Pratico',
                    topic: 'Statistica',
                  },
                },
                '3'
              )
            );
          if (phase === 'knowledge' || phase === 'plan')
            events.push(
              event(
                'course-diagnostic-stage',
                {
                  collectionId: 'setup-diagnostic',
                  stage:
                    phase === 'knowledge'
                      ? {
                          kind: 'self-assessment',
                          id: 'self',
                          title: 'Le tue conoscenze iniziali',
                          topics: [
                            { id: 'probability', parentId: null, title: 'Probabilità' },
                            ...Array.from({ length: 5 }, (_, index) => ({
                              id: `topic-${index}`,
                              parentId: null,
                              title: `Statistica ${index + 1}`,
                            })),
                          ],
                        }
                      : {
                          kind: 'complete',
                          id: 'complete',
                          title: 'Pronti per il piano',
                          feedback: 'Il corso partirà dalle basi.',
                        },
                },
                '4'
              )
            );
          const signalType =
            phase === 'goal'
              ? 'user-answer'
              : phase === 'preferences'
                ? 'course-decision'
                : 'diagnostic-submission';
          await route.fulfill({
            json: {
              success: true,
              state: {
                run: {
                  id: 'setup-run',
                  projectId,
                  status: phase === 'cancelled' ? 'cancelled' : 'waiting',
                  cleanupStatus: phase === 'cancelled' ? 'completed' : 'not-required',
                  workflowId: 'course-interview',
                },
                publishedEvents: events,
                waits:
                  phase === 'cancelled'
                    ? []
                    : [
                        {
                          waitId: `wait-${phase}`,
                          signalType,
                          createdAt: timestamp,
                          expiresAt: '2099-11-02T12:00:00.000Z',
                          nodeInstanceId: 'setup',
                          schemaVersion: 1,
                        },
                      ],
              },
            },
          });
        });
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Impara un nuovo argomento', exact: true }).click();
        if (!mobile) {
          const chooser = page.waitForEvent('filechooser');
          await page.locator('[data-home-chat-target=attachment]').click();
          await (await chooser).setFiles([
            {
              name: 'statistics.md',
              mimeType: 'text/markdown',
              buffer: Buffer.from('# Statistica\nProbabilità per informatica.'),
            },
          ]);
        }
        const input = page.locator('input[data-home-chat-target=objective]');
        await input.fill('Vorrei imparare la statistica per informatica.');
        await input.press('Enter');
        assert.equal(
          await page.locator('html').evaluate(element => element.classList.contains('dark')),
          dark
        );
        const stage = page.locator('[data-course-setup-phase]');
        await page.locator('[data-course-setup-phase=goal]').waitFor();
        assert.equal(
          await page.locator('[aria-current=step]').getAttribute('aria-label'),
          'Obiettivo'
        );
        assert.equal(await page.locator('[data-setup-phase=sources]').count(), mobile ? 0 : 1);
        const clipStart = performance.now();
        await page.screenshot({ path: join(evidence, `${scene}-interview.png`), fullPage: false });
        if (!mobile) assert(await page.getByText('1 fonte', { exact: true }).isVisible());
        if (mobile) {
          await page.setViewportSize({ width: 390, height: 400 });
          await page.waitForTimeout(500);
          const stageHeight = await stage.evaluate(element => element.clientHeight);
          assert(
            stageHeight <= 400 * 0.75,
            `Setup frame exceeds its viewport allocation: ${stageHeight}`
          );
          await input.scrollIntoViewIfNeeded();
          await input.focus();
          await input.fill('Risposta con la tastiera aperta');
          await page.waitForTimeout(500);
          await input.scrollIntoViewIfNeeded();
          const bounds = await input.boundingBox();
          assert(
            bounds && bounds.y >= 0 && bounds.y + bounds.height <= 400,
            'Composer must fit the keyboard viewport'
          );
          await page.screenshot({ path: join(evidence, `${scene}-keyboard.png`) });
          await page.waitForTimeout(1500);
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForTimeout(500);
          await stage.scrollIntoViewIfNeeded();
        }
        await page.waitForTimeout(1000);
        await input.fill('Vorrei capire gli esempi applicati ai dati.');
        await input.press('Enter');
        await page.getByText('Valutazione risposta...', { exact: true }).waitFor();
        await page.screenshot({ path: join(evidence, `${scene}-evaluating.png`), fullPage: false });
        await page.waitForTimeout(1500);
        answerGate.resolve();
        await page.locator('[data-course-setup-phase=preferences]').waitFor();
        const initialConfirm = await page
          .locator('[data-home-chat-target=confirm-generate]')
          .boundingBox();
        const initialComposer = await input.boundingBox();
        assert(
          initialConfirm &&
            initialComposer &&
            initialConfirm.y + initialConfirm.height <= initialComposer.y,
          'New preferences reveal the confirmation automatically'
        );
        await page.locator('[data-course-preferences]').scrollIntoViewIfNeeded();
        await page.waitForTimeout(700);
        await page.screenshot({ path: join(evidence, `${scene}-controls.png`), fullPage: false });
        const depth = page.getByRole('slider', { name: 'Approfondimento' });
        const size = page.getByRole('slider', { name: 'Granularità' });
        await depth.focus();
        await depth.press('ArrowRight');
        await size.focus();
        await size.press('End');
        assert.equal(await depth.inputValue(), '3');
        assert.equal(await size.inputValue(), '4');
        const confirm = page.locator('[data-home-chat-target=confirm-generate]');
        await confirm.scrollIntoViewIfNeeded();
        const confirmBounds = await confirm.boundingBox();
        const composerBounds = await input.boundingBox();
        assert(
          confirmBounds &&
            composerBounds &&
            confirmBounds.y + confirmBounds.height <= composerBounds.y,
          'Confirmation must be above composer'
        );
        await page.screenshot({
          path: join(evidence, `${scene}-preferences.png`),
          fullPage: false,
        });
        await page.waitForTimeout(1500);
        assert(
          await stage.evaluate(
            element => element.clientWidth >= (element.parentElement?.clientWidth ?? 0) - 2
          )
        );
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.locator('[data-home-chat-target=confirm-generate]').click();
        await page.locator('[data-course-setup-phase=knowledge]').waitFor();
        assert.equal(
          await page.locator('[data-setup-phase=preferences]').getAttribute('data-state'),
          'done',
          'The completed preferences step remains visible during diagnostics'
        );
        assert.deepEqual(approval, {
          kind: 'approve',
          coursePlanningControls: { depth: 'more', granularity: 'much-less' },
        });
        await page.waitForTimeout(500);
        const diagnosticStart = await page
          .getByRole('heading', { name: 'Le tue conoscenze iniziali', exact: true })
          .boundingBox();
        const scrollBounds = await page.locator('.home-chat-scrollbar').boundingBox();
        const headerBounds = await page
          .getByRole('heading', { name: 'Prepariamo il tuo corso' })
          .boundingBox();
        assert(
          diagnosticStart &&
            scrollBounds &&
            diagnosticStart.y >= scrollBounds.y &&
            diagnosticStart.y < scrollBounds.y + scrollBounds.height,
          'Long diagnostic opens at its start without manual scrolling'
        );
        assert(
          headerBounds && scrollBounds && headerBounds.y + headerBounds.height <= scrollBounds.y,
          'Phase header stays above scrolling content'
        );
        assert.equal(
          await page.locator('[aria-current=step]').getAttribute('aria-label'),
          'Conoscenze'
        );
        await page.screenshot({ path: join(evidence, `${scene}-knowledge.png`), fullPage: false });
        await page.waitForTimeout(1500);
        await page.getByRole('slider', { name: 'Probabilità' }).focus();
        await page.getByRole('slider', { name: 'Probabilità' }).press('Home');
        for (let index = 1; index <= 5; index++) {
          await page.getByRole('slider', { name: `Statistica ${index}`, exact: true }).focus();
          await page
            .getByRole('slider', { name: `Statistica ${index}`, exact: true })
            .press('Home');
        }
        await page.getByRole('button', { name: 'Continua', exact: true }).click();
        await page.locator('[data-course-setup-phase=plan]').waitFor();
        assert.equal(await page.locator('[aria-current=step]').getAttribute('aria-label'), 'Piano');
        await page.waitForTimeout(700);
        results.push({
          scene,
          clipDurationMs: performance.now() - clipStart,
          clipStartMs: clipStart - recordingStarted,
          clipEndMs: performance.now() - recordingStarted,
          video: await page.video()?.path(),
        });
        await page.getByRole('button', { name: 'Annulla creazione corso' }).click();
        await stage.waitFor({ state: 'detached' });
        await page.getByRole('heading', { name: 'Cosa vuoi imparare oggi?' }).waitFor();
        assert.equal(cancellations, 1);
        assert.equal(await stage.count(), 0);
        results.push({ scene, elapsedMs: performance.now() - started, approval, cancellations });
      }
    );
  }
}
assert.deepEqual(errors, []);
await writeFile(
  join(evidence, 'result.json'),
  JSON.stringify(
    {
      profile:
        'fixture-driven interview, isolated browser contexts, real app/controller/storage, headless Chromium',
      results,
      errors,
    },
    null,
    2
  )
);
