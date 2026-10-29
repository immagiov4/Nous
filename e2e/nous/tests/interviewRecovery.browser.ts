import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unavailableCourseGenerationApi } from '../../../apps/backend/src/workflows/courseGenerationApi';
import { CourseInterviewTargetNotFoundError } from '../../../apps/backend/src/workflows/courseInterviewApi';
import { dataRoot, withMemoryProjectBrowserStack } from '../stack';

const startedAt = performance.now();
const USER_ID = 'interview-recovery-user';
const starts: string[] = [];
await withMemoryProjectBrowserStack(
  {
    userId: USER_ID,
    appOptions: {
      courseGenerationApi: { ...unavailableCourseGenerationApi, getActive: async () => null },
      courseInterviewApi: {
        getActive: async () => null,
        start: async input => {
          starts.push(input.projectId);
          throw new CourseInterviewTargetNotFoundError();
        },
      },
    },
  },
  async ({ page, store, url }) => {
    const evidence = join(dataRoot(), 'interview-recovery');
    await mkdir(evidence, { recursive: true });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('input[data-home-chat-target=objective]').waitFor();
    await page.getByRole('button', { name: 'Impara un nuovo argomento', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-home-chat-target=attachment]').click();
    await (await chooser).setFiles([
      {
        name: 'recovery-notes.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Recovery source\nPrepared learning material.'),
      },
      {
        name: 'recovery-exercises.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Exercises\nPractice using the prepared material.'),
      },
    ]);
    const objective = page.locator('input[data-home-chat-target=objective]');
    await objective.fill('Create a course from these notes');
    const rejected = page.waitForResponse(
      response =>
        response.url().endsWith('/api/course-interviews') && response.request().method() === 'POST'
    );
    await objective.press('Enter');
    assert.equal((await rejected).status(), 404);
    await page
      .getByText('L’intervista per il corso non è riuscita. Riprova.', { exact: true })
      .waitFor();
    await page.screenshot({ path: join(evidence, 'failed-start.png'), fullPage: true });
    assert.equal(starts.length, 1);
    const draftId = starts[0];
    const draft = await store.loadProject(USER_ID, draftId);
    assert(draft?.source);
    const sources = await store.loadProjectSources(USER_ID, draftId);
    assert.equal(sources.length, 2);
    assert(sources.every(source => source.file.data.length > 0));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const retry = page.waitForResponse(
      response =>
        response.url().endsWith('/api/course-interviews') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Nuovo progetto', exact: true }).click();
    const retryResponse = await retry.catch(async error => {
      await page.screenshot({ path: join(evidence, 'recovery-failed.png'), fullPage: true });
      await writeFile(
        join(evidence, 'recovery-failed.txt'),
        await page.locator('body').innerText()
      );
      throw error;
    });
    assert.equal(retryResponse.status(), 404);
    assert.deepEqual(starts, [draftId, draftId]);
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
