import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unavailableCourseGenerationApi } from '../../../apps/backend/src/workflows/courseGenerationApi';
import {
  type CourseInterviewApi,
  CourseInterviewTargetNotFoundError,
} from '../../../apps/backend/src/workflows/courseInterviewApi';
import { dataRoot, withMemoryProjectBrowserStack } from '../stack';

const USER_ID = 'interview-recovery-user';
const originalSources = [
  { name: 'recovery-notes.md', text: '# Recovery source\nPrepared learning material.' },
  { name: 'recovery-exercises.md', text: '# Exercises\nPractice using the prepared material.' },
];
for (const withSources of [true, false]) {
  const startedAt = performance.now();
  const starts: Parameters<CourseInterviewApi['start']>[0][] = [];
  const objectiveText = withSources
    ? 'Teach these notes for query optimization'
    : 'Teach database query optimization';
  await withMemoryProjectBrowserStack(
    {
      userId: USER_ID,
      appOptions: {
        courseGenerationApi: { ...unavailableCourseGenerationApi, getActive: async () => null },
        courseInterviewApi: {
          getActive: async () => null,
          start: async input => {
            starts.push(input);
            throw new CourseInterviewTargetNotFoundError();
          },
        },
      },
    },
    async ({ page, store, url }) => {
      const evidence = join(dataRoot(), 'interview-recovery', withSources ? 'sources' : 'learn');
      await mkdir(evidence, { recursive: true });
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('input[data-home-chat-target=objective]').waitFor();
      await writeFile(
        join(evidence, 'initial.json'),
        JSON.stringify(
          {
            browser: await page.evaluate(() => ({
              language: navigator.language,
              languages: navigator.languages,
              renderedLanguage: document.documentElement.lang,
              authMode: Reflect.get(globalThis, '__NOUS_RUNTIME_CONFIG__')?.authMode,
            })),
            buttons: await page.getByRole('button').allTextContents(),
            projectsStatus: (await page.request.get(`${url}/api/projects/projects`)).status(),
            profile: 'memory-project/local-bypass',
          },
          null,
          2
        )
      );
      await page.screenshot({ path: join(evidence, 'initial.png'), fullPage: true });
      await page.getByRole('button', { name: 'Impara un nuovo argomento', exact: true }).click();
      if (withSources) {
        const chooser = page.waitForEvent('filechooser');
        await page.locator('[data-home-chat-target=attachment]').click();
        await (await chooser).setFiles(
          originalSources.map(source => ({
            name: source.name,
            mimeType: 'text/markdown',
            buffer: Buffer.from(source.text),
          }))
        );
      }
      const objective = page.locator('input[data-home-chat-target=objective]');
      await objective.fill(objectiveText);
      const rejected = page.waitForResponse(
        response =>
          response.url().endsWith('/api/course-interviews') &&
          response.request().method() === 'POST'
      );
      await objective.press('Enter');
      assert.equal((await rejected).status(), 404);
      await page
        .getByText('L’intervista per il corso non è riuscita. Riprova.', { exact: true })
        .waitFor();
      await page.screenshot({ path: join(evidence, 'failed-start.png'), fullPage: true });
      assert.equal(starts.length, 1);
      const draftId = starts[0].projectId;
      const draft = await store.loadProject(USER_ID, draftId);
      assert(draft);
      assert.equal(Boolean(draft.source), withSources);
      const sources = await store.loadProjectSources(USER_ID, draftId);
      assert.equal(sources.length, withSources ? 2 : 0);
      assert(sources.every(source => source.file.data.length > 0));
      await page.reload({ waitUntil: 'domcontentloaded' });
      const retry = page.waitForResponse(
        response =>
          response.url().endsWith('/api/course-interviews') &&
          response.request().method() === 'POST'
      );
      await page
        .getByRole('button', {
          name: withSources ? 'Nuovo progetto' : 'Nuovo percorso AI',
          exact: true,
        })
        .click();
      const retryResponse = await retry.catch(async error => {
        await page.screenshot({ path: join(evidence, 'recovery-failed.png'), fullPage: true });
        await writeFile(
          join(evidence, 'recovery-failed.txt'),
          await page.locator('body').innerText()
        );
        throw error;
      });
      assert.equal(retryResponse.status(), 404);
      assert.deepEqual(
        starts.map(input => input.projectId),
        [draftId, draftId]
      );
      assert.equal(starts[1].initialMessage, objectiveText);
      assert.equal(starts[0].initialMessage, objectiveText);
      assert.equal(starts[1].hasReliableSourceContext, withSources);
      for (const source of withSources ? originalSources : []) {
        assert(starts[1].sourceContext?.includes(JSON.stringify(source.text).slice(1, -1)));
      }
      assert.deepEqual((await store.loadProject(USER_ID, draftId))?.source, draft.source);
      assert.deepEqual(await store.loadProjectSources(USER_ID, draftId), sources);
      await page
        .getByText('L’intervista per il corso non è riuscita. Riprova.', { exact: true })
        .waitFor();
      await page.screenshot({ path: join(evidence, 'retried-draft.png'), fullPage: true });
      assert.deepEqual(pageErrors, []);
      await writeFile(
        join(evidence, 'result.json'),
        JSON.stringify(
          {
            draftId,
            starts,
            sourceCount: sources.length,
            sourcePreserved: true,
            reloadBeforeRetry: true,
            elapsedMs: performance.now() - startedAt,
          },
          null,
          2
        )
      );
      console.log(
        'Interview recovery UI proof passed: uploaded source, observed 404, reloaded library and retried the same preserved draft.'
      );
    }
  );
}
