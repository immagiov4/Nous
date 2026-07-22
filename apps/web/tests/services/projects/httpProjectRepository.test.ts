import assert from 'node:assert/strict';
import { beforeEach, expect, test, vi } from 'vitest';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';
import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
} from '../../../services/projects/courseSources.ts';
import { HttpProjectRepository } from '../../../services/projects/httpProjectRepository.ts';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';
import { consumeProjectRevisionStream } from '../../../services/projects/projectRevisionStream.ts';
import { normalizeStoredProject } from '../../../services/projects/projectSnapshot.ts';
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

test('HttpProjectRepository writes favorites through the project API', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      meta: { id: 'project-1', isFavorite: true },
    }),
  });

  const repository = new HttpProjectRepository('http://localhost:3301');
  await expect(repository.setProjectFavorite('project-1', true)).resolves.toMatchObject({
    id: 'project-1',
    isFavorite: true,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'http://localhost:3301/api/projects/projects/project-1/favorite',
    expect.objectContaining({ body: '{"isFavorite":true}', method: 'PATCH' })
  );
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

test('HttpProjectRepository gives archive saves enough time to upload and index large sources', async () => {
  vi.useFakeTimers();
  let resolveFetch: ((response: unknown) => void) | undefined;
  fetchMock.mockImplementationOnce(
    (_url: string, init: RequestInit) =>
      new Promise(resolve => {
        resolveFetch = resolve;
        expect(init.signal?.aborted).toBe(false);
      })
  );
  const repository = new HttpProjectRepository('http://localhost:3301');
  const snapshot: ProjectSnapshot = {
    ...buildPdfSnapshot(),
    id: 'large-archive-project',
    sourceKind: 'codebase',
    source: {
      file: {
        data: '',
        mimeType: 'application/zip',
        name: 'engine.zip',
      },
      index: { entries: [] },
      kind: 'archive',
      name: 'engine.zip',
    },
  };
  const archiveFile = new File(['PK large archive'], 'engine.zip', {
    type: 'application/zip',
  });

  const savePromise = repository.saveProject(snapshot, { archiveFile });
  await vi.advanceTimersByTimeAsync(15_001);

  const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(requestInit?.signal?.aborted).toBe(false);

  resolveFetch?.({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      meta: {
        id: snapshot.id,
        title: 'Engine',
        sourceKind: 'codebase',
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        lastOpenedAt: snapshot.lastOpenedAt,
        lessonCount: 0,
        completedCount: 0,
        exerciseCount: 0,
        completedExercises: 0,
        hasSourceFile: true,
        coverLabel: 'engine.zip',
      },
      snapshot,
    }),
  });
  await savePromise;
  vi.useRealTimers();
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

test('HttpProjectRepository creates a sourced project with one atomic PUT', async () => {
  const detachedSnapshot = {
    ...buildPdfSnapshot(),
    source: {
      kind: 'pdf',
      file: {
        data: '',
        mimeType: 'application/pdf',
        name: 'dispensa.pdf',
      },
      ref: {
        byteSize: 8,
        hash: 'pdf-hash',
        id: 'source-pdf',
        mimeType: 'application/pdf',
        name: 'dispensa.pdf',
        objectPath: 'users/user/projects/pdf/source-pdf/pdf-hash/original',
      },
    },
  } satisfies ProjectSnapshot;
  fetchMock.mockResolvedValueOnce({
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
      snapshot: detachedSnapshot,
    }),
  });

  const repository = new HttpProjectRepository('http://localhost:3301');
  const saved = await repository.saveProject(buildPdfSnapshot());

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'http://localhost:3301/api/projects/projects/pdf-project'
  );
  const saveBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
  expect(saveBody.snapshot.source).toEqual({
    kind: 'pdf',
    file: {
      name: 'dispensa.pdf',
      mimeType: 'application/pdf',
      data: 'JVBERi0xLjQ=',
    },
  });
  expect(saved.snapshot).toEqual(normalizeStoredProject(detachedSnapshot));
});

test('HttpProjectRepository preserves detached siblings when replacing one source', async () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: 'b2xkLWZpcnN0', mimeType: 'text/plain', name: 'first.txt' },
    { data: 'bmV3LXNlY29uZA==', mimeType: 'text/plain', name: 'second.txt' },
  ]);
  const firstRef = {
    byteSize: 9,
    hash: 'a'.repeat(64),
    id: descriptors[0].id,
    mimeType: 'text/plain',
    name: 'first.txt',
    objectPath: `users/user/projects/project/${descriptors[0].id}/original`,
  };
  const source = createProjectSourceFromDescriptors([
    {
      ...descriptors[0],
      file: { ...descriptors[0].file, data: '' },
      ref: firstRef,
    },
    descriptors[1],
  ]);
  const replaceSnapshot = {
    ...buildPdfSnapshot(),
    id: 'replace-project',
    source,
  };
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        sources: [
          {
            file: { ...descriptors[0].file, data: 'b2xkLWZpcnN0' },
            ref: firstRef,
          },
        ],
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        meta: {
          id: 'replace-project',
          title: 'Replace',
          sourceKind: 'document',
          createdAt: '2026-07-09T10:00:00.000Z',
          updatedAt: '2026-07-09T10:00:00.000Z',
          lastOpenedAt: '2026-07-09T10:00:00.000Z',
          lessonCount: 0,
          completedCount: 0,
          exerciseCount: 0,
          completedExercises: 0,
          hasSourceFile: true,
          coverLabel: 'first.txt',
        },
        snapshot: replaceSnapshot,
      }),
    });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await repository.saveProject(replaceSnapshot);

  expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
    'http://localhost:3301/api/projects/projects/replace-project/sources',
    'http://localhost:3301/api/projects/projects/replace-project',
  ]);
  const saved = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
  expect(
    saved.snapshot.source.sources.map((item: { file: { data: string } }) => item.file.data)
  ).toEqual(['b2xkLWZpcnN0', 'bmV3LXNlY29uZA==']);
});

test('HttpProjectRepository sends every document source in the atomic project PUT', async () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: 'Zmlyc3Q=', mimeType: 'text/plain', name: 'notes.txt' },
    { data: 'c2Vjb25k', mimeType: 'text/plain', name: 'notes.txt' },
  ]);
  const snapshot: ProjectSnapshot = {
    ...buildPdfSnapshot(),
    id: 'multi-project',
    source: createProjectSourceFromDescriptors(descriptors),
  };
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      meta: {
        id: 'multi-project',
        title: 'Multi',
        sourceKind: 'document',
        createdAt: '2026-07-09T10:00:00.000Z',
        updatedAt: '2026-07-09T10:00:00.000Z',
        lastOpenedAt: '2026-07-09T10:00:00.000Z',
        lessonCount: 0,
        completedCount: 0,
        exerciseCount: 0,
        completedExercises: 0,
        hasSourceFile: true,
        coverLabel: 'notes.txt',
      },
      snapshot,
    }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await repository.saveProject(snapshot);

  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'http://localhost:3301/api/projects/projects/multi-project'
  );
  const savedSnapshot = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    .snapshot as ProjectSnapshot;
  expect(savedSnapshot.source?.file.data).toBe('Zmlyc3Q=');
  expect(savedSnapshot.source?.sources?.map(descriptor => descriptor.file.data)).toEqual([
    'Zmlyc3Q=',
    'c2Vjb25k',
  ]);
});

test('HttpProjectRepository uploads archives as binary multipart without a JSON content type', async () => {
  const detachedArchiveSource = {
    file: {
      data: '',
      mimeType: 'application/zip',
      name: 'engine.zip',
    },
    index: { entries: [] },
    kind: 'archive' as const,
    name: 'engine.zip',
    ref: {
      byteSize: 5,
      hash: 'archive-hash',
      id: 'source-archive',
      mimeType: 'application/zip',
      name: 'engine.zip',
      objectPath: 'users/user/projects/archive/source-archive/archive-hash/original',
    },
  };
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      meta: {
        id: 'archive-project',
        title: 'Engine',
        sourceKind: 'codebase',
        createdAt: '2026-07-09T10:00:00.000Z',
        updatedAt: '2026-07-09T10:00:00.000Z',
        lastOpenedAt: '2026-07-09T10:00:00.000Z',
        lessonCount: 0,
        completedCount: 0,
        exerciseCount: 0,
        completedExercises: 0,
        hasSourceFile: true,
        coverLabel: 'engine.zip',
      },
      snapshot: {
        ...buildPdfSnapshot(),
        id: 'archive-project',
        source: detachedArchiveSource,
        sourceKind: 'codebase',
      },
    }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');
  const snapshot: ProjectSnapshot = {
    ...buildPdfSnapshot(),
    id: 'archive-project',
    sourceKind: 'codebase',
    source: {
      file: {
        data: '',
        mimeType: 'application/zip',
        name: 'engine.zip',
      },
      index: { entries: [] },
      kind: 'archive',
      name: 'engine.zip',
    },
  };
  const archiveFile = new File(['PK binary archive'], 'engine.zip', {
    type: 'application/zip',
  });

  const saved = await repository.saveProject(snapshot, { archiveFile });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(requestInit.body).toBeInstanceOf(FormData);
  expect(new Headers(requestInit.headers).has('Content-Type')).toBe(false);
  const saveBody = requestInit.body as FormData;
  const sentArchive = saveBody.get('archive');
  expect(sentArchive).toBeInstanceOf(File);
  expect((sentArchive as File).name).toBe(archiveFile.name);
  expect(await (sentArchive as File).text()).toBe(await archiveFile.text());
  expect(JSON.parse(String(saveBody.get('snapshot'))).source).toEqual({
    file: {
      data: '',
      mimeType: 'application/zip',
      name: 'engine.zip',
    },
    index: { entries: [] },
    kind: 'archive',
    name: 'engine.zip',
  });
  expect(saved.snapshot.source).toEqual(detachedArchiveSource);
});

test('HttpProjectRepository chunks large binary archives before upload', async () => {
  const snapshot: ProjectSnapshot = {
    ...buildPdfSnapshot(),
    id: 'chunked-archive',
    sourceKind: 'codebase',
    source: {
      file: { data: '', mimeType: 'application/zip', name: 'engine.zip' },
      index: { entries: [] },
      kind: 'archive',
      name: 'engine.zip',
    },
  };
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        config: {
          import: {
            directMaxBytes: 10_000_000,
            maxChunkBytes: 10_000_000,
            maxChunkCount: 4,
            maxSerializedBytes: 32_000_000,
            requestTimeoutMs: 10_000,
          },
        },
      }),
    })
    .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ success: true }) })
    .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ success: true }) })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, meta: { id: snapshot.id }, snapshot }),
    });

  await new HttpProjectRepository('http://localhost:3301').saveProject(snapshot, {
    archiveFile: new File([new Uint8Array(16_000_001)], 'engine.zip', {
      type: 'application/zip',
    }),
  });

  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls.slice(1, 3).every(call => call[1]?.body instanceof Blob)).toBe(true);
  expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/complete');
});

test('HttpProjectRepository does not fall back to Base64 JSON for archives', async () => {
  const repository = new HttpProjectRepository('http://localhost:3301');
  const snapshot: ProjectSnapshot = {
    ...buildPdfSnapshot(),
    source: {
      file: {
        data: 'UEsDBAo=',
        mimeType: 'application/zip',
        name: 'engine.zip',
      },
      index: { entries: [] },
      kind: 'archive',
      name: 'engine.zip',
    },
  };

  await expect(repository.saveProject(snapshot)).rejects.toThrow(
    'Gli archivi devono essere caricati come file binari.'
  );
  expect(fetchMock).not.toHaveBeenCalled();
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
