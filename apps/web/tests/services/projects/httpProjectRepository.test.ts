import assert from 'node:assert/strict';
import { beforeEach, expect, test, vi } from 'vitest';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';
import { HttpProjectRepository } from '../../../services/projects/httpProjectRepository.ts';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';
import { consumeProjectRevisionStream } from '../../../services/projects/projectRevisionStream.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  clearSupabaseSession();
});

const buildPdfSnapshot = (): ProjectSnapshot => ({
  id: 'pdf-project',
  version: '4.1',
  sourceKind: 'document',
  state: AppState.READING,
  source: {
    kind: 'pdf',
    file: {
      name: 'dispensa.pdf',
      mimeType: 'application/pdf',
      data: 'JVBERi0xLjQ=',
    },
  },
  learningPlan: null,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: null,
  createdAt: '2026-07-09T10:00:00.000Z',
  updatedAt: '2026-07-09T10:00:00.000Z',
  lastOpenedAt: '2026-07-09T10:00:00.000Z',
  documentAssets: null,
  documentIndex: null,
});

test('HttpProjectRepository sends the Supabase bearer token to the backend', async () => {
  saveSupabaseSession({ accessToken: 'access-token-123' });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      success: true,
      folders: [],
    }),
  });

  const repository = new HttpProjectRepository('http://localhost:3301');
  await repository.listFolders();

  const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(requestInit?.headers).toMatchObject({
    Authorization: 'Bearer access-token-123',
  });
});

test('HttpProjectRepository preserves backend errors instead of reporting server as unavailable', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    statusText: 'Unauthorized',
    json: async () => ({
      success: false,
      error: 'Autenticazione non configurata per questa installazione.',
    }),
  });

  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () => repository.listFolders(),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.message === 'Autenticazione non configurata per questa installazione.'
  );
});

test('HttpProjectRepository only uses the server unavailable message for network failures', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () => repository.listFolders(),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.message ===
        'Sincronizzazione server non disponibile. Verifica che il backend sia acceso e raggiungibile.'
  );
});

test('HttpProjectRepository reports request timeouts without claiming the backend is offline', async () => {
  fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));

  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () => repository.listFolders(),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.message ===
        'La sincronizzazione sta impiegando troppo tempo. Il backend e raggiungibile, ma non ha completato la richiesta.'
  );
});

test('HttpProjectRepository refreshes once and retries a backend 401', async () => {
  saveSupabaseSession({
    accessToken: 'access-token-old',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: 'refresh-token-old',
  });
  fetchMock
    .mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ success: false, error: 'Sessione scaduta.' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'access-token-new',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh-token-new',
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, folders: [] }),
    });

  const repository = new HttpProjectRepository('http://localhost:3301');
  await repository.listFolders();

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
    Authorization: 'Bearer access-token-new',
  });
});

test('HttpProjectRepository uploads a new PDF once and saves a lightweight snapshot', async () => {
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        sourceRef: {
          id: 'source-123',
          hash: 'hash-123',
          byteSize: 8,
          name: 'dispensa.pdf',
          mimeType: 'application/pdf',
        },
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        meta: {
          id: 'pdf-project',
          title: 'Dispensa',
          sourceKind: 'document',
          createdAt: '2026-07-09T10:00:00.000Z',
          updatedAt: '2026-07-09T10:00:00.000Z',
          lastOpenedAt: '2026-07-09T10:00:00.000Z',
          lessonCount: 0,
          completedCount: 0,
          exerciseCount: 0,
          completedExercises: 0,
          hasSourceFile: true,
          coverLabel: 'dispensa.pdf',
        },
      }),
    });

  const repository = new HttpProjectRepository('http://localhost:3301');
  await repository.saveProject(buildPdfSnapshot());

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'http://localhost:3301/api/projects/projects/pdf-project/source'
  );
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    source: {
      name: 'dispensa.pdf',
      mimeType: 'application/pdf',
      data: 'JVBERi0xLjQ=',
    },
  });

  const saveBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
  expect(saveBody.snapshot.source).toEqual({
    kind: 'pdf',
    file: {
      name: 'dispensa.pdf',
      mimeType: 'application/pdf',
      data: '',
    },
    ref: {
      id: 'source-123',
      hash: 'hash-123',
      byteSize: 8,
      name: 'dispensa.pdf',
      mimeType: 'application/pdf',
    },
  });
  expect(saveBody.omitSource).toBeUndefined();
});

test('HttpProjectRepository sends the expected revision and preserves a 409 conflict', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 409,
    statusText: 'Conflict',
    json: async () => ({
      success: false,
      error: "Il progetto è stato modificato in un'altra sessione.",
    }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () =>
      repository.patchProject('project-1', { state: AppState.READING }, { expectedRevision: 4 }),
    (error: unknown) => error instanceof ProjectStorageError && error.code === 'revision-conflict'
  );

  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    expectedRevision: 4,
    patch: { state: AppState.READING },
  });
});

test('HttpProjectRepository chunks imports that exceed the proxy request limit', async () => {
  const importedSnapshot = buildPdfSnapshot();
  const importTemplate = {
    ...importedSnapshot,
    documentIndex: { text: '' },
  };
  const serializedTemplate = JSON.stringify(importTemplate);
  const textPrefix = serializedTemplate.indexOf('"text":""') + '"text":"'.length;
  const beforeBoundaryEmoji = 16_000_000 - textPrefix - 1;
  const largeImport = {
    ...importTemplate,
    documentIndex: {
      text: `${'x'.repeat(beforeBoundaryEmoji)}😀${'x'.repeat(33_000_000 - beforeBoundaryEmoji)}`,
    },
  };
  let completionAttempts = 0;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/api/projects/config')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          success: true,
          config: {
            import: {
              directMaxBytes: 20_000_000,
              maxChunkBytes: 16_000_000,
              maxChunkCount: 32,
              maxSerializedBytes: 280_000_000,
              requestTimeoutMs: 120_000,
            },
          },
        }),
      };
    }
    const isCompletion = url.includes('/complete');
    const completionAttempt = isCompletion ? completionAttempts++ : -1;
    if (completionAttempt === 0) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new Error('connection lost while reading completion response');
        },
      };
    }
    const chunkMatch = /\/chunks\/[^/]+\/(\d+)\?chunkCount=(\d+)$/u.exec(url);
    const chunkIndex = Number(chunkMatch?.[1]);
    const chunkCount = Number(chunkMatch?.[2]);
    return {
      ok: true,
      status: isCompletion ? 200 : 202,
      statusText: 'OK',
      json: async () =>
        isCompletion
          ? {
              success: true,
              complete: true,
              meta: {
                id: importedSnapshot.id,
                title: 'Dispensa',
                sourceKind: 'document',
                createdAt: importedSnapshot.createdAt,
                updatedAt: importedSnapshot.updatedAt,
                lastOpenedAt: importedSnapshot.lastOpenedAt,
                lessonCount: 0,
                completedCount: 0,
                exerciseCount: 0,
                completedExercises: 0,
                hasSourceFile: true,
                coverLabel: 'dispensa.pdf',
              },
              snapshot: importedSnapshot,
            }
          : {
              success: true,
              complete: false,
              ready: chunkIndex === chunkCount - 1,
              receivedCount: chunkIndex + 1,
            },
    };
  });

  const repository = new HttpProjectRepository('http://localhost:3301');
  await repository.importProject(largeImport);

  expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  const chunkCalls = fetchMock.mock.calls.filter(call =>
    /\/chunks\/[^/]+\/\d+\?chunkCount=\d+$/u.test(String(call[0]))
  );
  const completionCalls = fetchMock.mock.calls.filter(call =>
    String(call[0]).includes('/complete')
  );
  const requests = chunkCalls.map((call: unknown[]) => ({
    url: String(call[0]),
    chunk: String((call[1] as RequestInit).body),
  }));
  expect(requests.map(request => Number(/\/chunks\/[^/]+\/(\d+)/u.exec(request.url)?.[1]))).toEqual(
    requests.map((_, index) => index)
  );
  expect(requests.every(request => new Blob([request.chunk]).size <= 16_000_000)).toBe(true);
  for (let index = 0; index < requests.length - 1; index += 1) {
    const left = requests[index]?.chunk || '';
    const right = requests[index + 1]?.chunk || '';
    const leftCodeUnit = left.charCodeAt(left.length - 1);
    const rightCodeUnit = right.charCodeAt(0);
    expect(
      leftCodeUnit >= 0xd800 &&
        leftCodeUnit <= 0xdbff &&
        rightCodeUnit >= 0xdc00 &&
        rightCodeUnit <= 0xdfff
    ).toBe(false);
  }
  expect(requests.map(request => request.chunk).join('')).toBe(JSON.stringify(largeImport));
  expect(completionCalls).toHaveLength(2);
  expect(new Set(completionCalls.map(call => String(call[0]))).size).toBe(1);
  expect(String(completionCalls[0]?.[0])).toMatch(/\/api\/projects\/import\/chunks\/.+\/complete$/);
});

test('consumeProjectRevisionStream emits only complete valid SSE events', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': heartbeat\n\ndata: {"projectId":"project-1",'));
      controller.enqueue(
        encoder.encode('"revision":2}\n\ndata: {"projectId":"project-2","revision":"bad"}\n\n')
      );
      controller.close();
    },
  });
  const events: Array<{ projectId: string; revision: number }> = [];

  await consumeProjectRevisionStream(stream, event => events.push(event));

  expect(events).toEqual([{ projectId: 'project-1', revision: 2 }]);
});
