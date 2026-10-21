import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { PROJECT_IMPORT_BINARY_KIND } from '@shared/projectImportContract';
import request from 'supertest';
import { beforeEach, expect, test, vi } from 'vitest';
import { withMutedAudio } from '../../../../scripts/browser-audio';
import { buildPdfPageFixture } from '../fixtures/pdfText.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

const provider = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock('ai', async original => ({
  ...(await original<typeof import('ai')>()),
  generateText: provider.generateText,
}));
vi.mock('../../src/services/aiSdkTextModel.js', async original => ({
  ...(await original<typeof import('../../src/services/aiSdkTextModel.js')>()),
  createConfiguredTextModel: () => ({ model: {}, providerOptions: {} }),
}));
const { createApp } = await import('../../src/index.js');
const { setProjectStoreForTesting } = await import('../../src/projects/projectStore.js');

beforeEach(() => {
  provider.generateText.mockReset();
});

test.runIf(process.env.NOUS_398_SLOW_PROOF === '1')(
  'real scanned PDF preparation survives 130 seconds and a retry joins without a second transcription',
  async () => {
    const evidence = process.env.SOURCE_PREPARATION_PROOF_DIR;
    if (!evidence)
      throw new Error('Set SOURCE_PREPARATION_PROOF_DIR to a private evidence directory.');
    const { createCanvas } = createRequire(createRequire(import.meta.url).resolve('pdf-parse'))(
      '@napi-rs/canvas'
    );
    const canvas = createCanvas(400, 500);
    const drawing = canvas.getContext('2d');
    drawing.fillStyle = 'white';
    drawing.fillRect(0, 0, 400, 500);
    drawing.fillStyle = 'black';
    drawing.font = '20px sans-serif';
    drawing.fillText('Synthetic scanned source', 20, 70);
    drawing.fillText('A finite set has finitely', 20, 120);
    drawing.fillText('many elements.', 20, 150);
    const rgba = drawing.getImageData(0, 0, 400, 500).data;
    const rgb = Buffer.alloc(400 * 500 * 3);
    for (let pixel = 0; pixel < 400 * 500; pixel++)
      for (let channel = 0; channel < 3; channel++)
        rgb[pixel * 3 + channel] = rgba[pixel * 4 + channel];
    const pdf = buildPdfPageFixture([
      `q 200 0 0 200 0 0 cm BI /W 400 /H 500 /CS /RGB /BPC 8 /F /AHx ID ${rgb.toString('hex')}> EI Q`,
    ]);
    await writeFile(`${evidence}/own-scanned-fixture.pdf`, pdf);
    await writeFile(`${evidence}/own-scanned-fixture.png`, canvas.toBuffer('image/png'));
    const entered = Promise.withResolvers<void>();
    provider.generateText.mockImplementation(async () => {
      entered.resolve();
      await delay(130_000);
      return {
        output: {
          status: 'ok',
          markdown: '# Synthetic scanned source\n\nA finite set has finitely many elements.',
        },
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    });
    const store = new InMemoryProjectStore();
    setProjectStoreForTesting(store);
    const app = createApp();
    const id = 'slow-synthetic-course';
    const file = {
      name: 'synthetic-scan.pdf',
      mimeType: 'application/pdf',
      data: '',
      sourceId: 'source-scan',
    };
    const snapshot = {
      id,
      version: '4.1',
      state: 'ASSESSMENT',
      sourceKind: 'document',
      learningPlan: null,
      isLearnMode: false,
      userProfile: null,
      syllabus: [],
      activeSectionId: null,
      createdAt: '2026-10-21T12:00:00.000Z',
      updatedAt: '2026-10-21T12:00:00.000Z',
      lastOpenedAt: '2026-10-21T12:00:00.000Z',
      source: {
        kind: 'pdf',
        file,
        sources: [
          {
            id: 'source-scan',
            name: file.name,
            file,
            kind: 'pdf',
            hash: '0'.repeat(64),
            status: 'ready',
            position: 0,
            outline: [],
            outlineOrigin: 'none',
          },
        ],
      },
    };
    const prefix = Buffer.from(
      JSON.stringify({
        snapshot,
        sourceFiles: [
          { id: 'source-scan', name: file.name, mimeType: file.mimeType, byteSize: pdf.length },
        ],
      })
    );
    const bytes = Buffer.concat([prefix, pdf]);
    const uploadId = crypto.randomUUID();
    const timeline: unknown[] = [];
    try {
      const started = performance.now();
      await request(app)
        .put(
          `/api/projects/import/chunks/${uploadId}/0?chunkCount=1&sourceUpload=true&projectId=${id}&contentKey=synthetic-proof`
        )
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)
        .expect(202);
      const accepted = await request(app)
        .post(`/api/projects/import/chunks/${uploadId}/complete`)
        .send({ payloadKind: PROJECT_IMPORT_BINARY_KIND.sourceSet, metadataBytes: prefix.length })
        .expect(202);
      timeline.push({
        event: 'accepted',
        elapsedMs: performance.now() - started,
        status: accepted.status,
      });
      await expect
        .poll(
          async () => {
            const state = await request(app).get(`/api/projects/import/chunks/${uploadId}`);
            if (state.status >= 400) throw new Error(JSON.stringify(state.body));
            await writeFile(`${evidence}/slow-current-status.json`, JSON.stringify(state.body));
            return provider.generateText.mock.calls.length;
          },
          { timeout: 10_000 }
        )
        .toBe(1);
      await entered.promise;
      await delay(16_000);
      const progress = await request(app)
        .get(`/api/projects/import/chunks/${uploadId}`)
        .expect(202);
      expect(progress.body.progress).toMatchObject({
        step: 'pdf-transcription',
        completed: 0,
        total: 1,
      });
      const retry = await request(app)
        .put(
          `/api/projects/import/chunks/${crypto.randomUUID()}/0?chunkCount=1&sourceUpload=true&projectId=${id}&contentKey=synthetic-proof`
        )
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)
        .expect(202);
      expect(retry.body.uploadId).toBe(uploadId);
      const reopening = await request(app).get(`/api/projects/projects/${id}`).expect(200);
      expect(reopening.body.preparation.uploadId).toBe(uploadId);
      const library = await request(app).get('/api/projects/projects').expect(200);
      expect(library.body.projects.map((project: { id: string }) => project.id)).toContain(id);
      timeline.push({
        event: 'retry-and-reload-attached',
        elapsedMs: performance.now() - started,
        progress: progress.body.progress,
        providerCalls: provider.generateText.mock.calls.length,
      });
      await delay(110_000);
      const overProxyLimit = await request(app)
        .get(`/api/projects/import/chunks/${uploadId}`)
        .expect(202);
      expect(overProxyLimit.body.progress.step).toBe('pdf-transcription');
      timeline.push({
        event: 'past-125-seconds',
        elapsedMs: performance.now() - started,
        providerCalls: provider.generateText.mock.calls.length,
      });
      await expect
        .poll(
          async () =>
            (await request(app).get(`/api/projects/import/chunks/${uploadId}`)).body.complete,
          { timeout: 10_000 }
        )
        .toBe(true);
      const done = await request(app).get(`/api/projects/import/chunks/${uploadId}`).expect(200);
      expect(done.body.snapshot.source.sources[0].preparedPdfText.pages[0].provenance.kind).toBe(
        'vision-transcription'
      );
      expect(provider.generateText).toHaveBeenCalledOnce();
      timeline.push({
        event: 'completed',
        elapsedMs: performance.now() - started,
        providerCalls: provider.generateText.mock.calls.length,
      });
      await writeFile(`${evidence}/slow-real-route-proof.json`, JSON.stringify(timeline, null, 2));
    } finally {
      setProjectStoreForTesting(null);
    }
  },
  180_000
);

test.runIf(process.env.NOUS_398_BROWSER_PROOF === '1')(
  'real interface shows preparation on desktop and mobile and retains it across reload',
  async () => {
    const evidence = process.env.SOURCE_PREPARATION_PROOF_DIR;
    if (!evidence) throw new Error('Set SOURCE_PREPARATION_PROOF_DIR.');
    const { createServer } = await import('vite');
    const { createServer: createHttpServer } = await import('node:http');
    const { chromium } = await import('playwright');
    const hold = Promise.withResolvers<void>();
    provider.generateText.mockImplementation(async () => {
      await hold.promise;
      return {
        output: { status: 'ok', markdown: 'A finite set has finitely many elements.' },
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    });
    let app: ReturnType<typeof createApp>;
    setProjectStoreForTesting(new InMemoryProjectStore());
    const backend = createHttpServer((req, res) => app(req, res)).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => backend.once('listening', resolve));
    const backendPort = (backend.address() as { port: number }).port;
    const vite = await createServer({
      configFile: `${process.cwd()}/apps/web/vite.config.ts`,
      mode: 'test',
      server: {
        port: 0,
        host: '127.0.0.1',
        strictPort: false,
        proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true } },
      },
    });
    await vite.listen();
    assert.ok(vite.httpServer);
    const frontendPort = (vite.httpServer.address() as { port: number }).port;
    const url = `http://127.0.0.1:${frontendPort}`;
    const previousOrigins = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = url;
    app = createApp();
    const browser = await chromium.launch(withMutedAudio({ headless: true }));
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.addInitScript(() => {
        (globalThis as Record<string, unknown>).__NOUS_RUNTIME_CONFIG__ = {
          authMode: 'local-bypass',
          backendUrl: location.origin,
        };
      });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page
        .locator('input[type=file]')
        .first()
        .setInputFiles(`${evidence}/own-scanned-fixture.pdf`);
      await page
        .getByRole('textbox')
        .first()
        .fill('Prepara un corso basato sul documento sintetico allegato.');
      await page.getByRole('textbox').first().press('Enter');
      await page
        .getByText(/Trascrizione pagine/)
        .first()
        .waitFor({ state: 'visible' });
      await page.screenshot({ path: `${evidence}/desktop-after-preparing.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${evidence}/mobile-after-preparing.png`, fullPage: true });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('own-scanned-fixture.pdf', { exact: true }).first().waitFor();
      await writeFile(
        `${evidence}/browser-after-reload.txt`,
        await page.locator('body').innerText()
      );
      await page.screenshot({ path: `${evidence}/mobile-after-reload.png`, fullPage: true });
      const resumedPoll = page.waitForResponse(
        response =>
          response.request().method() === 'GET' &&
          response.url().includes('/api/projects/import/chunks/')
      );
      await page.getByText('own-scanned-fixture.pdf', { exact: true }).first().click();
      expect((await resumedPoll).status()).toBe(202);
      await page
        .getByText('Preparazione fonti...', { exact: true })
        .first()
        .waitFor({ state: 'visible' });
      await page.screenshot({ path: `${evidence}/mobile-after-resume.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: `${evidence}/desktop-after-resume.png`, fullPage: true });
      expect(provider.generateText).toHaveBeenCalledOnce();
    } finally {
      await browser.close();
      hold.resolve();
      await vite.close();
      backend.closeAllConnections();
      await new Promise<void>(resolve => backend.close(() => resolve()));
      process.env.CORS_ALLOWED_ORIGINS = previousOrigins;
      setProjectStoreForTesting(null);
    }
  },
  180_000
);

test.runIf(process.env.NOUS_398_RECOVERY_PROOF === '1')(
  'a persistence failure keeps the paid transcript for retry and remains visible after reload',
  async () => {
    const evidence = process.env.SOURCE_PREPARATION_PROOF_DIR;
    if (!evidence) throw new Error('Set SOURCE_PREPARATION_PROOF_DIR.');
    const pdf = await readFile(`${evidence}/own-scanned-fixture.pdf`);
    provider.generateText.mockResolvedValue({
      output: { status: 'ok', markdown: 'A finite set has finitely many elements.' },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const store = new InMemoryProjectStore();
    const save = vi
      .spyOn(store, 'saveProject')
      .mockRejectedValueOnce(new Error('synthetic persistence failure'));
    setProjectStoreForTesting(store);
    const app = createApp();
    const projectId = 'recovery-proof-course';
    const file = {
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      data: '',
      sourceId: 'source-scan',
    };
    const snapshot = {
      id: projectId,
      version: '4.1',
      state: 'ASSESSMENT',
      sourceKind: 'document',
      learningPlan: null,
      isLearnMode: false,
      userProfile: null,
      syllabus: [],
      activeSectionId: null,
      createdAt: '2026-10-21T12:00:00.000Z',
      updatedAt: '2026-10-21T12:00:00.000Z',
      lastOpenedAt: '2026-10-21T12:00:00.000Z',
      source: {
        kind: 'pdf',
        file,
        sources: [
          {
            id: file.sourceId,
            name: file.name,
            file,
            kind: 'pdf',
            hash: '0'.repeat(64),
            status: 'ready',
            position: 0,
            outline: [],
            outlineOrigin: 'none',
          },
        ],
      },
    };
    const prefix = Buffer.from(
      JSON.stringify({
        snapshot,
        sourceFiles: [
          { id: file.sourceId, name: file.name, mimeType: file.mimeType, byteSize: pdf.length },
        ],
      })
    );
    const upload = async () => {
      const uploadId = crypto.randomUUID();
      await request(app)
        .put(
          `/api/projects/import/chunks/${uploadId}/0?chunkCount=1&sourceUpload=true&projectId=${projectId}`
        )
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.concat([prefix, pdf]))
        .expect(202);
      await request(app)
        .post(`/api/projects/import/chunks/${uploadId}/complete`)
        .send({ payloadKind: PROJECT_IMPORT_BINARY_KIND.sourceSet, metadataBytes: prefix.length })
        .expect(202);
      return uploadId;
    };
    try {
      const first = await upload();
      await expect
        .poll(async () => (await request(app).get(`/api/projects/import/chunks/${first}`)).status, {
          timeout: 10_000,
        })
        .toBe(500);
      const library = await request(app).get('/api/projects/projects').expect(200);
      expect(library.body.projects).toContainEqual(
        expect.objectContaining({ id: projectId, sourcePreparationStatus: 'failed' })
      );
      const reopening = await request(app).get(`/api/projects/projects/${projectId}`).expect(200);
      expect(reopening.body.preparation).toMatchObject({ uploadId: first, status: 'failed' });
      const second = await upload();
      await expect
        .poll(
          async () =>
            (await request(app).get(`/api/projects/import/chunks/${second}`)).body.complete,
          { timeout: 10_000 }
        )
        .toBe(true);
      const done = await request(app).get(`/api/projects/import/chunks/${second}`).expect(200);
      expect(done.body.snapshot.source.sources[0].preparedPdfText.pages[0].provenance.kind).toBe(
        'vision-transcription'
      );
      expect(provider.generateText).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledTimes(2);
      await writeFile(
        `${evidence}/persistence-recovery-proof.json`,
        JSON.stringify(
          {
            firstStatus: 'failed',
            retryStatus: 'completed',
            transcriptionCalls: provider.generateText.mock.calls.length,
            saveCalls: save.mock.calls.length,
          },
          null,
          2
        )
      );
    } finally {
      setProjectStoreForTesting(null);
    }
  },
  30_000
);
