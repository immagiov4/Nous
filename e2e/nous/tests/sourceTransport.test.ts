import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../../apps/backend/src/index';
import { setProjectStoreForTesting } from '../../../apps/backend/src/projects/projectStore';
import { InMemoryProjectStore } from '../../../apps/backend/tests/helpers/inMemoryProjectStore';
import { HttpProjectRepository } from '../../../apps/web/services/projects/httpProjectRepository';
import { AppState, type ProjectSnapshot } from '../../../apps/web/types';
import { SOURCE_TRANSFER_LIMITS } from '../../../packages/shared-types/sourceTransfer';
import { createFakeCloudflareProxy } from '../fakeCloudflareProxy';

const servers: Server[] = [];
const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  return `http://127.0.0.1:${address.port}`;
};
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
    )
  );
});

const limits = {
  ...SOURCE_TRANSFER_LIMITS,
  maxRequestBytes: 512,
  firstByteTimeoutMs: 100,
  originWriteTimeoutMs: 100,
};

test('enforces body size at the real HTTP proxy without buffering or invoking the origin', async () => {
  let called = false;
  const target = await listen(
    createServer((_req, res) => {
      called = true;
      res.end('unexpected');
    })
  );
  const proxy = await listen(createFakeCloudflareProxy({ target, limits }));
  const response = await fetch(proxy, {
    method: 'POST',
    body: new Uint8Array(limits.maxRequestBytes + 1),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({
    code: 'FAKE_PROXY_BODY_LIMIT',
    layer: 'fake-cloudflare',
  });
  expect(called).toBe(false);
});

test('identifies an unsafe synchronous request that never sends its first byte', async () => {
  const target = await listen(createServer(() => {}));
  const proxy = await listen(createFakeCloudflareProxy({ target, limits }));
  const response = await fetch(proxy);
  expect(response.status).toBe(504);
  expect(await response.json()).toMatchObject({ code: 'FAKE_PROXY_FIRST_BYTE_LIMIT' });
});

test('identifies an origin write that remains incomplete', async () => {
  const target = await listen(createServer(() => {}));
  const proxy = await listen(createFakeCloudflareProxy({ target, limits }));
  const response = await new Promise<{ status: number | undefined; body: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        proxy,
        { method: 'POST', headers: { 'Content-Length': 2 } },
        incoming => {
          let body = '';
          incoming.setEncoding('utf8');
          incoming.on('data', chunk => {
            body += chunk;
          });
          incoming.on('end', () => {
            outgoing.destroy();
            resolve({ status: incoming.statusCode, body });
          });
        }
      );
      outgoing.on('error', reject);
      outgoing.write('a');
    }
  );
  expect(response.status).toBe(504);
  expect(JSON.parse(response.body)).toMatchObject({ code: 'FAKE_PROXY_ORIGIN_WRITE_LIMIT' });
});

test('the production HTTP adapter chunks files and polls an asynchronous job through the same proxy model', async () => {
  const store = new InMemoryProjectStore();
  setProjectStoreForTesting(store);
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => {
    finish = resolve;
  });
  let entered!: () => void;
  const processing = new Promise<void>(resolve => {
    entered = resolve;
  });
  const save = store.saveProject.bind(store);
  vi.spyOn(store, 'saveProject').mockImplementationOnce(async (...args) => {
    entered();
    await blocked;
    return save(...args);
  });
  let accepted!: () => void;
  const acceptance = new Promise<void>(resolve => {
    accepted = resolve;
  });
  const origin = createServer(createApp());
  let parts = 0;
  origin.on('request', (req, res) => {
    if (req.method === 'PUT' && req.url?.includes('/import/chunks/')) parts += 1;
    if (req.url?.endsWith('/complete'))
      res.once('finish', () => {
        if (res.statusCode === 202) accepted();
      });
  });
  const target = await listen(origin);
  const model = {
    ...limits,
    maxPartBytes: 256,
    firstByteTimeoutMs: 1000,
    originWriteTimeoutMs: 1000,
  };
  const proxy = await listen(createFakeCloudflareProxy({ target, limits: model }));
  const repository = new HttpProjectRepository(proxy, model);
  const snapshot: ProjectSnapshot = {
    id: 'proxy-course',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.ASSESSMENT,
    source: null,
    learningPlan: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    createdAt: '',
    updatedAt: '',
    lastOpenedAt: '',
  };
  const text = 'Synthetic course source. '.repeat(100);
  const saving = repository.saveProject(snapshot, {
    sourceFiles: [new File([text], 'lesson.txt', { type: 'text/plain' })],
  });
  try {
    await acceptance;
    await processing;
    expect(parts).toBeGreaterThan(1);
    expect(await store.loadProject('local-user', snapshot.id)).toBeNull();
    finish();
    const result = await saving;
    expect(result.snapshot.documentIndex?.chunks.map(chunk => chunk.text).join('')).toBe(
      text.trim()
    );
    expect(result.snapshot.source?.sources).toMatchObject([
      { name: 'lesson.txt', status: 'ready' },
    ]);
  } finally {
    finish();
    await saving.catch(() => undefined);
    setProjectStoreForTesting(null);
  }
});
