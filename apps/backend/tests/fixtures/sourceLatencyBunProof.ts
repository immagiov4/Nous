import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { PROJECT_IMPORT_BINARY_KIND } from '@shared/projectImportContract';
import request, { type Response } from 'supertest';
import { buildPdfPageFixture } from './pdfText.js';

const provider = { calls: 0 };
const ai = await import('ai');
mock.module('ai', () => ({
  ...ai,
  generateText: async () => {
    provider.calls++;
    return {
      output: { status: 'ok', markdown: 'Synthetic page.' },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
}));
const originalTextModel = await import('../../src/services/aiSdkTextModel.ts');
const textModel = () => ({
  ...originalTextModel,
  createConfiguredTextModel: () => ({ model: {}, providerOptions: {} }),
});
mock.module('../../src/services/aiSdkTextModel.js', textModel);
mock.module('../../src/services/aiSdkTextModel.ts', textModel);
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'local-bypass';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.SUPABASE_URL = '';
const PROJECT_REQUEST_TIMEOUT_MS = 15_000;
assert.ok(process.versions.bun, 'Run the backend proof through Bun.');
if (!process.env.PROBE_OUTPUT) throw new Error('Set PROBE_OUTPUT outside the repository.');

const { default: express } = await import('express');
const { default: projects } = await import('../../src/routes/projects.js');
const { resolveCurrentUser } = await import('../../src/auth/currentUser.js');
const createApp = () =>
  express()
    .use(express.raw({ type: 'application/octet-stream', limit: '20mb' }))
    .use(express.json({ limit: '20mb' }))
    .use(resolveCurrentUser)
    .use('/api/projects', projects);
const { setProjectStoreForTesting } = await import('../../src/projects/projectStore.js');
const { InMemoryProjectStore } = await import('../helpers/inMemoryProjectStore.js');
const width = Number(process.env.PROBE_WIDTH || 2500),
  height = Number(process.env.PROBE_HEIGHT || 3500),
  pages = Number(process.env.PROBE_PAGES || 16);
const rgb = Buffer.alloc(width * height * 3, 255);
for (let y = 100; y < height - 100; y += 40)
  for (let x = 100; x < width - 100; x++)
    if (x % 31 < 16)
      for (let row = 0; row < 8; row++)
        rgb.fill(0, ((y + row) * width + x) * 3, ((y + row) * width + x) * 3 + 3);
const compressed = deflateSync(rgb).toString('hex');
const background = '0 0 200 200 re f\n'.repeat(Number(process.env.PROBE_BACKGROUND_RECTS || 0));
const stream = `${background} q 200 0 0 200 0 0 cm BI /W ${width} /H ${height} /CS /RGB /BPC 8 /F [/AHx /Fl] ID ${compressed}> EI Q`;
const bytes = buildPdfPageFixture(Array(pages).fill(stream));
let previous = performance.now(),
  maxLag = 0,
  ticks = 0;
const timer = setInterval(() => {
  const now = performance.now();
  maxLag = Math.max(maxLag, now - previous - 20);
  previous = now;
  ticks++;
}, 20);
setProjectStoreForTesting(new InMemoryProjectStore());
const app = createApp();
const server = createServer(app).listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const snapshot = {
  id: 'lag-unrelated',
  version: '4.1',
  state: 'ASSESSMENT',
  sourceKind: 'document',
  source: null,
  learningPlan: null,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: null,
  createdAt: '2026-10-21T12:00:00.000Z',
  updatedAt: '2026-10-21T12:00:00.000Z',
  lastOpenedAt: '2026-10-21T12:00:00.000Z',
};
const client = spawn(
  process.env.PROBE_NODE || 'node',
  [
    '-e',
    `let stopped=false;process.stdin.on('data',()=>{stopped=true;});console.log('ready');setTimeout(async()=>{const requests=[];do{const started=performance.now();const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),${PROJECT_REQUEST_TIMEOUT_MS});try{const r=await fetch('http://127.0.0.1:${port}/api/projects/projects/lag-unrelated',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({snapshot:${JSON.stringify(snapshot)}}),signal:controller.signal});await r.text();requests.push({elapsedMs:performance.now()-started,status:r.status});}catch(e){requests.push({elapsedMs:performance.now()-started,error:e.name});}finally{clearTimeout(timeout);}require('node:fs').writeFileSync(process.env.PROBE_OUTPUT+'.client.json',JSON.stringify({requests}));if(!stopped)await new Promise(r=>setTimeout(r,100));}while(!stopped);console.log(JSON.stringify({requests}));process.exit(0);},10);`,
  ],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
);
let clientOutput = '';
client.stdout.on('data', chunk => {
  clientOutput += chunk;
});
await once(client.stdout, 'data');
const clientDone = once(client, 'close');
const started = performance.now();
try {
  const file = {
    name: 'synthetic-scan.pdf',
    mimeType: 'application/pdf',
    data: '',
    sourceId: 'source-scan',
  };
  const sourceSnapshot = {
    ...snapshot,
    id: 'scanned-latency-source',
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
      snapshot: sourceSnapshot,
      sourceFiles: [
        { id: 'source-scan', name: file.name, mimeType: file.mimeType, byteSize: bytes.length },
      ],
    })
  );
  const uploadId = crypto.randomUUID();
  await request(app)
    .put(
      `/api/projects/import/chunks/${uploadId}/0?chunkCount=1&sourceUpload=true&projectId=${sourceSnapshot.id}`
    )
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.concat([prefix, bytes]))
    .expect(202);
  await request(app)
    .post(`/api/projects/import/chunks/${uploadId}/complete`)
    .send({ payloadKind: PROJECT_IMPORT_BINARY_KIND.sourceSet, metadataBytes: prefix.length })
    .expect(202);
  const scheduledMs = performance.now() - started;
  let state: Response;
  do {
    state = await request(app).get(`/api/projects/import/chunks/${uploadId}`);
    if (state.status >= 400) throw new Error(JSON.stringify(state.body));
    if (state.status === 202) await new Promise(r => setTimeout(r, 100));
  } while (state.status === 202);
  assert.equal(state.body.complete, true);
  const completedSources = state.body.snapshot?.source?.sources || [];
  assert.equal(completedSources.length, 1);
  assert.equal(completedSources[0].preparedPdfText.pages.length, pages);
  const failedPages = completedSources.flatMap(
    (source: { preparedPdfText?: { failedPages?: number[] } }) =>
      source.preparedPdfText?.failedPages || []
  );
  const result = { transcription: { failedPages } };
  client.stdin.end('stop');
  await clientDone;
  await new Promise(r => setTimeout(r, 30));
  await writeFile(
    process.env.PROBE_OUTPUT ||
      (() => {
        throw new Error('Set PROBE_OUTPUT outside the repository.');
      })(),
    JSON.stringify({
      runtime: process.versions.bun,
      pages,
      width,
      height,
      bytes: bytes.length,
      scheduledMs,
      totalMs: performance.now() - started,
      maxLag,
      ticks,
      clientOutput,
      calls: provider.calls,
      failed: result.transcription?.failedPages,
    })
  );
  const sample = JSON.parse(clientOutput.trim().split('\n').at(-1) || '{}') as {
    requests: Array<{ elapsedMs: number; status?: number; error?: string }>;
  };
  assert.ok(sample.requests.length > 0);
  assert.ok(
    sample.requests.every(
      request => request.status === 200 && request.elapsedMs < PROJECT_REQUEST_TIMEOUT_MS
    )
  );
  assert.equal(provider.calls, pages);
  assert.deepEqual(result.transcription?.failedPages, []);
} finally {
  clearInterval(timer);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  client.kill();
  setProjectStoreForTesting(null);
}

// Import-session maintenance belongs to the backend lifetime; this executable proof is complete.
process.exit(0);
