import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { withMutedAudio } from '../../../scripts/browser-audio';
import { dataRoot } from '../stack';

const startedAt = performance.now();

// Use the product's local test authentication and real project HTTP routes.
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'local-bypass';
const { createApp } = await import('../../../apps/backend/src/index');
const { InMemoryProjectStore } = await import(
  '../../../apps/backend/tests/helpers/inMemoryProjectStore'
);
const { setProjectStoreForTesting } = await import(
  '../../../apps/backend/src/projects/projectStore'
);
const { CourseInterviewTargetNotFoundError } = await import(
  '../../../apps/backend/src/workflows/courseInterviewApi'
);
const { unavailableCourseGenerationApi } = await import(
  '../../../apps/backend/src/workflows/courseGenerationApi'
);
const store = new InMemoryProjectStore();
setProjectStoreForTesting(store);
const starts: string[] = [];
const backend = createHttpServer();
backend.listen(0, '127.0.0.1');
await new Promise<void>(resolve => backend.once('listening', resolve));
const address = backend.address();
assert(address && typeof address !== 'string');
const frontend = await createServer({
  configFile: resolve('apps/web/vite.config.ts'),
  mode: 'test',
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    proxy: {
      '/api': { target: `http://127.0.0.1:${address.port}`, changeOrigin: true },
    },
  },
});
await frontend.listen();
const frontendUrl = frontend.resolvedUrls?.local[0];
assert(frontendUrl);
process.env.CORS_ALLOWED_ORIGINS = frontendUrl.replace(/\/$/, '');
const app = createApp({
  courseGenerationApi: { ...unavailableCourseGenerationApi, getActive: async () => null },
  courseInterviewApi: {
    getActive: async () => null,
    start: async input => {
      starts.push(input.projectId);
      throw new CourseInterviewTargetNotFoundError();
    },
  },
});
backend.on('request', app);
const browser = await chromium.launch(withMutedAudio({ headless: true }));
try {
  const evidence = join(dataRoot(), 'interview-recovery');
  await mkdir(evidence, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // Covers are optional decoration; no provider call belongs in this deterministic proof.
  await page.route('**/api/openrouter/**', route => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/images/**', route => route.fulfill({ status: 503, body: '{}' }));
  await page.addInitScript(
    url => {
      Object.assign(globalThis, {
        __NOUS_RUNTIME_CONFIG__: { authMode: 'local-bypass', backendUrl: url },
      });
    },
    frontendUrl.replace(/\/$/, '')
  );
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(frontendUrl, { waitUntil: 'domcontentloaded' });
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
  const draft = await store.loadProject('local-user', draftId);
  assert(draft?.source);
  const sources = await store.loadProjectSources('local-user', draftId);
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
    await writeFile(join(evidence, 'recovery-failed.txt'), await page.locator('body').innerText());
    throw error;
  });
  assert.equal(retryResponse.status(), 404);
  assert.deepEqual(starts, [draftId, draftId]);
  assert.deepEqual((await store.loadProject('local-user', draftId))?.source, draft.source);
  assert.deepEqual(await store.loadProjectSources('local-user', draftId), sources);
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
} finally {
  await browser.close();
  await frontend.close();
  await new Promise<void>((resolve, reject) =>
    backend.close(error => (error ? reject(error) : resolve()))
  );
  setProjectStoreForTesting(null);
}
