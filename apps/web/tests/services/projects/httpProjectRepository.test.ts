import assert from 'node:assert/strict';
import { PDF_SCANNED_PAGE_LIMIT_MESSAGE } from '@shared/pdfTranscription';
import { PROJECT_API_ERROR_CODE, PROJECT_PATCH_REBASE_MODE } from '@shared/projectContract';
import { PROJECT_IMPORT_BINARY_KIND } from '@shared/projectImportContract';
import {
  SOURCE_PREPARATION_CONFLICT_CODE,
  SOURCE_PREPARATION_CONFLICT_MESSAGE,
} from '@shared/sourcePreparation';
import { SOURCE_TRANSFER_LIMITS } from '@shared/sourceTransfer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setRenderingLocaleOverride } from '../../../i18n/uiMessages.ts';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';
import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
} from '../../../services/projects/courseSources.ts';
import { HttpProjectRepository } from '../../../services/projects/httpProjectRepository.ts';
import {
  PROJECT_REQUEST_TOO_LARGE_MESSAGE,
  PROJECT_SYNC_ERROR_MESSAGE,
  ProjectStorageError,
} from '../../../services/projects/projectRepository.ts';
import {
  consumeProjectRevisionStream,
  subscribeToProjectRevisionStream,
} from '../../../services/projects/projectRevisionStream.ts';
import { exportProjectData } from '../../../services/projects/projectSnapshot.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';
import { createDeferred } from '../../helpers/deferred.ts';

const fetchMock = vi.fn();
const { pushNousDebugTrace } = vi.hoisted(() => ({ pushNousDebugTrace: vi.fn() }));
vi.mock('../../../services/core/debugTrace.ts', () => ({ pushNousDebugTrace }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  clearSupabaseSession();
});

afterEach(() => setRenderingLocaleOverride(null));

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

const withStoredSourceReferences = (snapshot: ProjectSnapshot): ProjectSnapshot => {
  const descriptors = snapshot.source?.sources;
  assert(descriptors?.length);
  const source = createProjectSourceFromDescriptors(
    descriptors.map(descriptor => ({
      ...descriptor,
      ref: {
        id: descriptor.id,
        name: descriptor.name,
        mimeType: descriptor.file.mimeType,
        hash: descriptor.hash,
        byteSize: 16_000_001,
        objectPath: `stored/${descriptor.id}`,
      },
    }))
  );
  return { ...snapshot, source: { ...source, ref: source.sources?.[0]?.ref } };
};

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

test('HttpProjectRepository validates exported projects at the wire boundary', async () => {
  const exported = exportProjectData(buildPdfSnapshot());
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ data: exported, success: true }),
  });

  const repository = new HttpProjectRepository('http://localhost:3301');

  await expect(repository.exportProject('pdf-project')).resolves.toEqual(exported);
});

test('HttpProjectRepository rejects malformed canonical project exports', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      data: { id: 'broken-project', projectFormatVersion: 1 },
      success: true,
    }),
  });

  const repository = new HttpProjectRepository('http://localhost:3301');

  await expect(repository.exportProject('broken-project')).rejects.toMatchObject({
    code: 'persistence-failed',
    message: PROJECT_SYNC_ERROR_MESSAGE,
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
  await expect(
    repository.setProjectFavorite('project-1', true, { expectedRevision: 4 })
  ).resolves.toMatchObject({
    id: 'project-1',
    isFavorite: true,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'http://localhost:3301/api/projects/projects/project-1/favorite',
    expect.objectContaining({ body: '{"isFavorite":true,"expectedRevision":4}', method: 'PATCH' })
  );
});

test('preserves ordered failed document identities across a 422 response', async () => {
  const documents = [
    { id: 'one', name: 'same.pdf', state: 'error' },
    { id: 'two', name: 'same.pdf', state: 'error' },
  ];
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 422,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      success: false,
      code: 'SOURCE_PREPARATION_UNUSABLE',
      sourceDocuments: documents,
      sourceWarnings: [{ name: 'same.pdf', reason: 'no-usable-text' }],
    }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');
  await expect(repository.listFolders()).rejects.toMatchObject({
    code: 'source-preparation-failed',
    sourceDocuments: documents,
    sourceWarnings: [{ name: 'same.pdf' }],
  });
});

test('HttpProjectRepository hides generic backend error details', async () => {
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
      error.code === 'persistence-failed' &&
      error.message ===
        'Sincronizzazione server non disponibile. Verifica che il backend sia acceso e raggiungibile.'
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

test('HttpProjectRepository loads one encoded source ID without fetching the source set', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      source: { data: 'cGRm', mimeType: 'application/pdf', name: '049.pdf' },
      success: true,
    }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await expect(repository.loadProjectSourceById('project 1', 'source/049')).resolves.toMatchObject({
    name: '049.pdf',
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'http://localhost:3301/api/projects/projects/project%201/sources/source%2F049'
  );
});

test('HttpProjectRepository preserves a non-JSON proxy 413 response', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response('<html>Request Entity Too Large</html>', {
      headers: { 'Content-Type': 'text/html' },
      status: 413,
      statusText: 'Content Too Large',
    })
  );
  const repository = new HttpProjectRepository('http://localhost:3301');

  await expect(repository.listFolders()).rejects.toMatchObject({
    code: 'quota-exceeded',
    httpStatus: 413,
    message: PROJECT_REQUEST_TOO_LARGE_MESSAGE,
    name: 'ProjectStorageError',
    responseContentType: 'text/html',
  });
});

test('HttpProjectRepository preserves named preparation failures from the asynchronous job', async () => {
  setRenderingLocaleOverride('it');
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/config'))
      return new Response(
        JSON.stringify({
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
        })
      );
    if (init?.method === 'PUT')
      return new Response(JSON.stringify({ success: true }), { status: 202 });
    if (url.endsWith('/complete'))
      return new Response(JSON.stringify({ success: true, uploadStatus: 'finalizing' }), {
        status: 202,
      });
    return new Response(
      JSON.stringify({
        success: false,
        code: 'SOURCE_PREPARATION_UNUSABLE',
        sourceWarnings: [
          { name: 'scans/a.pdf', reason: 'no-usable-text' },
          { name: 'broken/b.pdf', reason: 'parser-failed' },
        ],
      }),
      { status: 422 }
    );
  });
  await expect(
    new HttpProjectRepository('http://localhost:3301').saveProject(buildPdfSnapshot(), {
      sourceFiles: [new File(['synthetic source'], 'dispensa.pdf', { type: 'application/pdf' })],
    })
  ).rejects.toMatchObject({
    code: 'source-preparation-failed',
    message: 'Nessuna delle fonti contiene testo utilizzabile.',
    sourceWarnings: [
      expect.objectContaining({ name: 'scans/a.pdf', reason: 'no-usable-text' }),
      expect.objectContaining({ name: 'broken/b.pdf', reason: 'parser-failed' }),
    ],
  });
});

test('HttpProjectRepository preserves retryable ZIP preparation capacity failures', async () => {
  setRenderingLocaleOverride('en');
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: PROJECT_API_ERROR_CODE.sourceArchiveBusy,
        error: 'technical backend detail',
        success: false,
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 429 }
    )
  );
  const repository = new HttpProjectRepository('http://localhost:3301');

  await expect(repository.listFolders()).rejects.toMatchObject({
    code: 'source-archive-busy',
    httpStatus: 429,
    message: 'A ZIP archive is already being prepared. Try again shortly.',
    name: 'ProjectStorageError',
  });
});

test('HttpProjectRepository maps archive preparation failures to a stable code', async () => {
  setRenderingLocaleOverride('it');
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: PROJECT_API_ERROR_CODE.sourceArchiveInvalid,
        error: 'technical backend detail',
        success: false,
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 422 }
    )
  );
  const repository = new HttpProjectRepository('http://localhost:3301');

  await expect(repository.listFolders()).rejects.toMatchObject({
    code: 'source-archive-invalid',
    httpStatus: 422,
    message: 'Non è stato possibile preparare l’archivio ZIP.',
    name: 'ProjectStorageError',
  });
});

test('HttpProjectRepository does not retry a non-JSON proxy 413 during chunk upload', async () => {
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
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
    })
    .mockResolvedValueOnce(
      new Response('<html>Request Entity Too Large</html>', {
        headers: { 'Content-Type': 'text/html' },
        status: 413,
        statusText: 'Content Too Large',
      })
    )
    .mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({ success: true }),
    });

  await expect(
    new HttpProjectRepository('http://localhost:3301').importProjectArchive(
      new Blob(['project backup'], { type: 'application/zip' }),
      'restored-project'
    )
  ).rejects.toMatchObject({
    code: 'quota-exceeded',
    httpStatus: 413,
    message: PROJECT_REQUEST_TOO_LARGE_MESSAGE,
    responseContentType: 'text/html',
  });

  const uploadCalls = fetchMock.mock.calls.filter(call =>
    /\/api\/projects\/import\/chunks\/[^/]+\/0\?chunkCount=1(?:&|$)/u.test(call[0] as string)
  );
  expect(uploadCalls).toHaveLength(1);
});

test('HttpProjectRepository reports request timeouts without claiming the backend is offline', async () => {
  fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));

  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () => repository.listFolders(),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.message ===
        'La sincronizzazione sta impiegando troppo tempo. Il backend è raggiungibile, ma non ha completato la richiesta.'
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

const sourceUploadTransport = (snapshot: ProjectSnapshot) => {
  const parts: Blob[] = [];
  let completion: { metadataBytes: number } | undefined;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/config'))
      return new Response(
        JSON.stringify({
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
        })
      );
    if (init?.method === 'PUT' && url.includes('/chunks/')) {
      parts.push(init.body as Blob);
      return new Response(JSON.stringify({ success: true }), { status: 202 });
    }
    if (url.endsWith('/complete')) {
      completion = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true, uploadStatus: 'finalizing' }), {
        status: 202,
      });
    }
    if (url.includes('/chunks/'))
      return new Response(
        JSON.stringify({
          success: true,
          complete: true,
          meta: { id: snapshot.id, revision: 1 },
          snapshot,
        })
      );
    throw new Error(`Unexpected source request: ${url}`);
  });
  return async () => {
    const body = new Blob(parts);
    assert.ok(completion);
    return {
      metadata: JSON.parse(await body.slice(0, completion.metadataBytes).text()),
      bytes: await body.slice(completion.metadataBytes).text(),
    };
  };
};

test('embedded PDF saves use the accepted source operation instead of a synchronous project PUT', async () => {
  const snapshot = buildPdfSnapshot();
  const uploaded = sourceUploadTransport(snapshot);
  await new HttpProjectRepository('http://localhost:3301').saveProject(snapshot);
  const { metadata, bytes } = await uploaded();
  expect(bytes).toBe('%PDF-1.4');
  expect(metadata.snapshot.source.sources).toMatchObject([{ file: { data: '' } }]);
  expect(metadata.sourceFiles).toMatchObject([{ name: 'dispensa.pdf', byteSize: 8 }]);
});

test('source operation identity preserves retries and distinguishes changed content or course metadata', async () => {
  const snapshot = buildPdfSnapshot();
  sourceUploadTransport(snapshot);
  const repository = new HttpProjectRepository('http://localhost:3301');
  await repository.saveProject(snapshot);
  await repository.saveProject({
    ...snapshot,
    updatedAt: '2026-10-21T12:00:00.000Z',
    lastOpenedAt: '2026-10-21T12:00:00.000Z',
  });
  await repository.saveProject({ ...snapshot, title: 'Different intended title' });
  assert(snapshot.source);
  await repository.saveProject({
    ...snapshot,
    source: {
      ...snapshot.source,
      file: { ...snapshot.source.file, data: btoa('%PDF-different-content') },
    },
  });
  const keys = fetchMock.mock.calls
    .filter(call => (call[1] as RequestInit)?.method === 'PUT')
    .map(call => new URL(String(call[0])).searchParams.get('contentKey'));
  expect(keys).toHaveLength(4);
  expect(keys[0]).toMatch(/^[a-f0-9]{64}$/u);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
  expect(keys[3]).not.toBe(keys[0]);
});

test.each([
  ['it', SOURCE_PREPARATION_CONFLICT_MESSAGE],
  [
    'en',
    'Other sources are already being prepared for this course. Wait for preparation to finish and try again.',
  ],
] as const)('a source conflict is localized in %s and terminates without upload retries', async (locale, message) => {
  setRenderingLocaleOverride(locale);
  const snapshot = buildPdfSnapshot();
  sourceUploadTransport(snapshot);
  const transport = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((url: string, init?: RequestInit) =>
    init?.method === 'PUT'
      ? new Response(JSON.stringify({ success: false, code: SOURCE_PREPARATION_CONFLICT_CODE }), {
          status: 409,
        })
      : transport?.(url, init)
  );
  try {
    await expect(
      new HttpProjectRepository('http://localhost:3301').saveProject(snapshot)
    ).rejects.toMatchObject({ code: 'source-preparation-conflict', httpStatus: 409, message });
    expect(
      fetchMock.mock.calls.filter(call => (call[1] as RequestInit)?.method === 'PUT')
    ).toHaveLength(1);
  } finally {
    setRenderingLocaleOverride(null);
  }
});

test('replacing one embedded source retains its detached sibling without downloading or transcribing it', async () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: 'Zmlyc3Q=', mimeType: 'text/plain', name: 'first.txt' },
    { data: 'c2Vjb25k', mimeType: 'text/plain', name: 'second.txt' },
  ]);
  const ref = {
    id: descriptors[0].id,
    hash: 'a'.repeat(64),
    byteSize: 5,
    mimeType: 'text/plain',
    name: 'first.txt',
    objectPath: 'synthetic/first',
  };
  const snapshot = {
    ...buildPdfSnapshot(),
    source: createProjectSourceFromDescriptors([
      { ...descriptors[0], ref, file: { ...descriptors[0].file, data: '' } },
      descriptors[1],
    ]),
  };
  const uploaded = sourceUploadTransport(snapshot);
  await new HttpProjectRepository('http://localhost:3301').saveProject(snapshot);
  const { metadata, bytes } = await uploaded();
  expect(bytes).toBe('second');
  expect(metadata.sourceFiles).toHaveLength(1);
  expect(metadata.snapshot.source.sources[0].ref).toEqual(ref);
});

test('embedded document sets use one accepted source operation with each original uploaded once', async () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: 'Zmlyc3Q=', mimeType: 'text/plain', name: 'first.txt' },
    { data: 'c2Vjb25k', mimeType: 'text/plain', name: 'second.txt' },
  ]);
  const snapshot = {
    ...buildPdfSnapshot(),
    source: createProjectSourceFromDescriptors(descriptors),
  };
  const uploaded = sourceUploadTransport(snapshot);
  await new HttpProjectRepository('http://localhost:3301').saveProject(snapshot);
  const { metadata, bytes } = await uploaded();
  expect(bytes).toBe('firstsecond');
  expect(metadata.sourceFiles.map((file: { id: string }) => file.id)).toEqual(
    descriptors.map(source => source.id)
  );
  expect(
    metadata.snapshot.source.sources.map((source: { file: { data: string } }) => source.file.data)
  ).toEqual(['', '']);
});

test('HttpProjectRepository preserves the expected revision when saving chunked sources', async () => {
  const file = new File(['x'.repeat(16_000_001)], 'lesson.txt', { type: 'text/plain' });
  const snapshot: ProjectSnapshot = {
    ...buildPdfSnapshot(),
    id: 'chunked-source',
    source: createProjectSourceFromDescriptors(
      buildCourseSourceDescriptors([{ name: file.name, mimeType: file.type, data: '' }])
    ),
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
      json: async () => ({
        success: true,
        meta: { id: snapshot.id },
        snapshot: withStoredSourceReferences(snapshot),
      }),
    });

  await new HttpProjectRepository('http://localhost:3301').saveProject(snapshot, {
    sourceFiles: [file],
    expectedRevision: 7,
  });

  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls.slice(1, 3).every(call => call[1]?.body instanceof Blob)).toBe(true);
  expect(
    fetchMock.mock.calls
      .slice(1, 3)
      .every(call => (call[0] as string).includes('expectedRevision=7'))
  ).toBe(true);
  expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/complete');
});

test('HttpProjectRepository recovers a completed chunked source save after losing its response', async () => {
  const file = new File(['x'.repeat(16_000_001)], 'lesson.txt', { type: 'text/plain' });
  const snapshot: ProjectSnapshot = {
    ...buildPdfSnapshot(),
    id: 'chunked-source',
    source: createProjectSourceFromDescriptors(
      buildCourseSourceDescriptors([{ name: file.name, mimeType: file.type, data: '' }])
    ),
  };

  const storedSnapshot = withStoredSourceReferences(snapshot);
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
    .mockResolvedValueOnce(
      new Response('{', { headers: { 'Content-Type': 'application/json' }, status: 200 })
    )
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        complete: true,
        meta: { id: snapshot.id },
        snapshot: storedSnapshot,
        success: true,
      }),
    });

  const saved = await new HttpProjectRepository('http://localhost:3301').saveProject(snapshot, {
    sourceFiles: [file],
  });

  expect(saved.snapshot.source).toEqual(storedSnapshot.source);
  expect(saved.meta).toEqual({ id: snapshot.id });
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/complete');
  expect(String(fetchMock.mock.calls[4]?.[0])).not.toContain('/complete');
  expect(fetchMock.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(false);
});

test('HttpProjectRepository cancels a rejected source completion without polling it', async () => {
  const files = [new File(['notes'], 'notes.txt', { type: 'text/plain' })];
  const source = createProjectSourceFromDescriptors(
    buildCourseSourceDescriptors([{ data: 'bm90ZXM=', mimeType: 'text/plain', name: 'notes.txt' }])
  );
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        config: {
          import: {
            directMaxBytes: 16_000_000,
            maxChunkBytes: 16_000_000,
            maxChunkCount: 32,
            maxSerializedBytes: 280_000_000,
            requestTimeoutMs: 120_000,
          },
        },
      }),
    })
    .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ success: true }) })
    .mockResolvedValueOnce(new Response('Too large', { status: 413 }))
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        complete: false,
        uploadStatus: 'receiving',
      }),
    });
  await expect(
    new HttpProjectRepository('http://localhost:3301').saveProject(
      { ...buildPdfSnapshot(), source },
      { sourceFiles: files }
    )
  ).rejects.toMatchObject({ code: 'quota-exceeded' });
  const calls = fetchMock.mock.calls.slice(3);
  expect(calls).toHaveLength(1);
  expect(calls[0][1].method).toBe('DELETE');
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

test('HttpProjectRepository labels self-contained backup uploads explicitly', async () => {
  const targetProjectId = 'restored-project';
  const restoredSnapshot = { ...buildPdfSnapshot(), id: targetProjectId };
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
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
    })
    .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ success: true }) })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        meta: { id: targetProjectId },
        snapshot: restoredSnapshot,
      }),
    });

  const imported = await new HttpProjectRepository('http://localhost:3301').importProjectArchive(
    new Blob(['project backup'], { type: 'application/zip' }),
    targetProjectId
  );

  expect(imported.snapshot.id).toBe(targetProjectId);
  expect(fetchMock.mock.calls[1]?.[1]?.body).toBeInstanceOf(Blob);
  expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
    payloadKind: 'project-backup',
    targetProjectId,
  });
});

test('HttpProjectRepository sends the expected revision and preserves a 409 conflict', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 409,
    statusText: 'Conflict',
    json: async () => ({
      code: PROJECT_API_ERROR_CODE.revisionConflict,
      success: false,
      error: "Il progetto è stato modificato in un'altra sessione.",
    }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () =>
      repository.patchProject('project-1', { state: AppState.READING }, { expectedRevision: 4 }),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.code === 'revision-conflict' &&
      error.message ===
        "Il progetto è stato modificato in un'altra sessione. Ricaricalo prima di salvare."
  );

  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    expectedRevision: 4,
    patch: { state: AppState.READING },
  });
});

test('HttpProjectRepository sends an explicit navigation rebase mode', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ success: true, meta: { id: 'project-1', revision: 6 } }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await repository.patchProject(
    'project-1',
    { activeSectionId: 'lesson-1', state: AppState.READING },
    { expectedRevision: 4, rebaseMode: PROJECT_PATCH_REBASE_MODE.navigation }
  );

  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    expectedRevision: 4,
    patch: { activeSectionId: 'lesson-1', state: AppState.READING },
    rebaseMode: PROJECT_PATCH_REBASE_MODE.navigation,
  });
});

test('HttpProjectRepository does not mislabel an unrelated 409 as a revision conflict', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 409,
    statusText: 'Conflict',
    json: async () => ({ success: false, error: 'Workflow request key already in use.' }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await expect(
    repository.patchProject('project-1', { state: AppState.READING })
  ).rejects.toMatchObject({
    code: 'persistence-failed',
    message: PROJECT_SYNC_ERROR_MESSAGE,
    name: 'ProjectStorageError',
  });
});

test('HttpProjectRepository returns the authoritative cover write revision', async () => {
  const meta = { id: 'project-1', revision: 8 };
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, meta }) });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await expect(
    repository.saveProjectCover(
      'project-1',
      {
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        name: 'cover.png',
      },
      { expectedRevision: 7 }
    )
  ).resolves.toEqual(meta);
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
    expectedRevision: 7,
  });
});

test('HttpProjectRepository distinguishes a cover revision conflict', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 409,
    statusText: 'Conflict',
    json: async () => ({
      code: PROJECT_API_ERROR_CODE.coverRevisionConflict,
      success: false,
      error: 'technical backend detail',
    }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await expect(
    repository.saveProjectCover('project-1', {
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
      name: 'cover.png',
    })
  ).rejects.toMatchObject({
    code: 'cover-revision-conflict',
    message: 'Il corso è cambiato prima del salvataggio della cover.',
    name: 'ProjectStorageError',
  });
});

test('HttpProjectRepository distinguishes a deleted project from a revision conflict', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    json: async () => ({ success: false, error: 'technical backend detail' }),
  });
  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () =>
      repository.patchProject('project-1', { state: AppState.READING }, { expectedRevision: 4 }),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.code === 'project-deleted' &&
      error.message === 'Questo corso è stato cancellato'
  );
});

test('HttpProjectRepository chunks imports that exceed the proxy request limit', async () => {
  const directMaxBytes = 20_000;
  const maxChunkBytes = 16_000;
  const maxSerializedBytes = 280_000;
  const importTextCharacters = 33_000;
  const importedSnapshot = buildPdfSnapshot();
  const importTemplate = {
    ...importedSnapshot,
    documentIndex: { text: '' },
  };
  const serializedTemplate = JSON.stringify(importTemplate);
  const textPrefix = serializedTemplate.indexOf('"text":""') + '"text":"'.length;
  const beforeBoundaryEmoji = maxChunkBytes - textPrefix - 1;
  const largeImport = {
    ...importTemplate,
    documentIndex: {
      text: `${'x'.repeat(beforeBoundaryEmoji)}😀${'x'.repeat(importTextCharacters - beforeBoundaryEmoji)}`,
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
              directMaxBytes,
              maxChunkBytes,
              maxChunkCount: 32,
              maxSerializedBytes,
              requestTimeoutMs: 120_000,
            },
          },
        }),
      };
    }
    const isCompletion = url.includes('/complete');
    const isStatus = /\/chunks\/[^/?]+$/u.test(url);
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
    const chunkMatch = /\/chunks\/[^/]+\/(\d+)\?chunkCount=(\d+)(?:&|$)/u.exec(url);
    const chunkIndex = Number(chunkMatch?.[1]);
    const chunkCount = Number(chunkMatch?.[2]);
    return {
      ok: true,
      status: isCompletion || isStatus ? 200 : 202,
      statusText: 'OK',
      json: async () =>
        isCompletion || isStatus
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
    /\/chunks\/[^/]+\/\d+\?chunkCount=\d+(?:&|$)/u.test(call[0] as string)
  );
  const completionCalls = fetchMock.mock.calls.filter(call =>
    (call[0] as string).includes('/complete')
  );
  const requests = chunkCalls.map((call: unknown[]) => ({
    url: call[0] as string,
    chunk: (call[1] as RequestInit).body as string,
  }));
  expect(requests.map(request => Number(/\/chunks\/[^/]+\/(\d+)/u.exec(request.url)?.[1]))).toEqual(
    requests.map((_, index) => index)
  );
  expect(requests.every(request => new Blob([request.chunk]).size <= maxChunkBytes)).toBe(true);
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
  expect(completionCalls).toHaveLength(1);
  expect(fetchMock.mock.calls.some(call => /\/chunks\/[^/?]+$/u.test(String(call[0])))).toBe(true);
  expect(new Set(completionCalls.map(call => call[0] as string)).size).toBe(1);
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

test('consumeProjectRevisionStream requests catch-up for an explicit server resync event', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: project-revision-resync\ndata: {}\n\n'));
      controller.close();
    },
  });
  const listener = vi.fn();
  const onResync = vi.fn();

  await consumeProjectRevisionStream(stream, listener, onResync);

  expect(listener).not.toHaveBeenCalled();
  expect(onResync).toHaveBeenCalledOnce();
});

test('subscribeToProjectRevisionStream requests catch-up on the first successful connection', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  fetchMock.mockResolvedValueOnce({ body: stream, ok: true, status: 200 });
  const requestCatchUp = vi.fn();

  const unsubscribe = subscribeToProjectRevisionStream({
    listener: vi.fn(),
    onCatchUp: requestCatchUp,
    url: 'http://localhost:3301/api/projects/events',
  });

  await vi.waitFor(() => expect(requestCatchUp).toHaveBeenCalledOnce());
  unsubscribe();
});

test.each([
  'immediate',
  'polled',
])('uploads all 30 sources in bounded binary requests and publishes metadata once (%s completion)', async completionMode => {
  const onSourceProgress = vi.fn();
  const files = Array.from(
    { length: 30 },
    (_, index) =>
      new File([`lesson-${index}`], `lesson-${index.toString().padStart(2, '0')}.txt`, {
        type: 'text/plain',
      })
  );
  const descriptors = buildCourseSourceDescriptors(
    files.map((file, index) => ({
      name: file.name,
      mimeType: file.type,
      data: Buffer.from(`lesson-${index}`).toString('base64'),
    }))
  );
  const source = createProjectSourceFromDescriptors(descriptors);
  for (const descriptor of descriptors) descriptor.file.data = '';
  const snapshot = { ...buildPdfSnapshot(), source };
  const bodies: Blob[] = [];
  const completions: Record<string, unknown>[] = [];
  const storedSource = createProjectSourceFromDescriptors(
    descriptors.map(descriptor => ({
      ...descriptor,
      ref: {
        id: descriptor.id,
        name: descriptor.name,
        mimeType: descriptor.file.mimeType,
        hash: descriptor.hash,
        byteSize: 8,
        objectPath: `stored/${descriptor.id}`,
      },
    }))
  );
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/projects/config'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          config: {
            import: {
              directMaxBytes: 20,
              maxChunkBytes: 27,
              maxChunkCount: 32,
              maxSerializedBytes: 280,
              requestTimeoutMs: 120000,
            },
          },
        }),
      };
    if (init?.method === 'PUT') {
      bodies.push(init.body as Blob);
      return { ok: true, status: 202, json: async () => ({ success: true }) };
    }
    if (init?.method === 'POST' && url.endsWith('/complete')) {
      completions.push(JSON.parse(init.body as string));
      if (completionMode === 'polled')
        return {
          ok: true,
          status: 202,
          json: async () => ({ success: true, uploadStatus: 'finalizing' }),
        };
    }
    if (
      (init?.method === 'POST' && url.endsWith('/complete')) ||
      ((init?.method ?? 'GET') === 'GET' &&
        /^\/api\/projects\/import\/chunks\/[^/]+$/.test(new URL(url).pathname))
    ) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          complete: true,
          meta: { id: snapshot.id, revision: 1 },
          progress: {
            step: 'persistence',
            completed: 30,
            total: 30,
            documents: descriptors.map(descriptor => ({
              id: descriptor.id,
              name: descriptor.name,
              state: 'done',
            })),
          },
          snapshot: {
            ...snapshot,
            source: { ...storedSource, ref: storedSource.sources?.[0]?.ref },
          },
        }),
      };
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const saved = await new HttpProjectRepository('http://localhost:3301').saveProject(snapshot, {
    sourceFiles: files,
    onSourceProgress,
  });
  expect(onSourceProgress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      step: 'persistence',
      completed: 30,
      total: 30,
      documents: descriptors.map(descriptor => ({
        id: descriptor.id,
        name: descriptor.name,
        state: 'done',
      })),
    })
  );
  expect(completions[0]?.snapshot).toBeUndefined();
  const metadataBytes = completions[0]?.metadataBytes as number;
  expect(JSON.parse(await new Blob(bodies).slice(0, metadataBytes).text())).toMatchObject({
    snapshot: {
      id: snapshot.id,
      source: {
        sources: descriptors.map(descriptor => ({
          id: descriptor.id,
        })),
      },
    },
    sourceFiles: descriptors.map(descriptor => ({ id: descriptor.id, name: descriptor.name })),
  });
  const metadata = JSON.parse(await new Blob(bodies).slice(0, metadataBytes).text());
  for (const descriptor of metadata.snapshot.source.sources)
    expect(descriptor).not.toHaveProperty('documentIndex');
  expect(await new Blob(bodies).slice(metadataBytes).text()).toBe(
    (await Promise.all(files.map(file => file.text()))).join('')
  );
  expect(bodies.every(body => body.size <= 27)).toBe(true);
  expect(completions).toHaveLength(1);
  expect(completions[0]).toMatchObject({
    payloadKind: PROJECT_IMPORT_BINARY_KIND.sourceSet,
  });
  expect(saved.snapshot.source?.sources).toHaveLength(30);
});

test('source preparation reports interruption after an accepted job disappears on backend restart', async () => {
  setRenderingLocaleOverride('it');
  const file = new File(['synthetic text'], 'lesson.txt', { type: 'text/plain' });
  const descriptors = buildCourseSourceDescriptors([
    { data: '', name: file.name, mimeType: file.type },
  ]);
  const snapshot = {
    ...buildPdfSnapshot(),
    source: createProjectSourceFromDescriptors(descriptors),
  };
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/config'))
      return {
        ok: true,
        status: 200,
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
    if (url.includes('?chunkCount='))
      return { ok: true, status: 202, json: async () => ({ success: true }) };
    if (url.endsWith('/complete'))
      return {
        ok: true,
        status: 202,
        json: async () => ({ success: true, uploadStatus: 'finalizing' }),
      };
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  });
  await expect(
    new HttpProjectRepository('http://localhost:3301').saveProject(snapshot, {
      sourceFiles: [file],
    })
  ).rejects.toMatchObject({
    code: 'source-preparation-interrupted',
    message: 'La preparazione delle fonti è stata interrotta. Riprova il caricamento.',
  });
});

test.each([
  204, 500,
])('cancellation handles HTTP %s while stopping further source upload parts', async status => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const controller = new AbortController();
  let parts = 0;
  let deletes = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/config'))
      return new Response(
        JSON.stringify({
          success: true,
          config: {
            import: {
              maxChunkBytes: 32,
              maxChunkCount: 32,
              maxSerializedBytes: 280,
              requestTimeoutMs: 120000,
              directMaxBytes: 20,
            },
          },
        })
      );
    if (init?.method === 'DELETE') {
      deletes++;
      return new Response(null, { status });
    }
    if (init?.method === 'PUT') {
      parts++;
      controller.abort();
      return new Response(JSON.stringify({ success: true }), { status: 202 });
    }
    throw new Error('Unexpected request after cancellation');
  });
  await expect(
    new HttpProjectRepository('http://localhost:3301').saveProject(buildPdfSnapshot(), {
      sourceFiles: [new File(['synthetic notes'], 'notes.txt', { type: 'text/plain' })],
      signal: controller.signal,
    })
  ).rejects.toBeDefined();
  expect(parts).toBe(1);
  expect(deletes).toBe(1);
  try {
    if (status === 204) {
      expect(warning).not.toHaveBeenCalled();
      expect(pushNousDebugTrace).toHaveBeenCalledWith(
        'project:request',
        expect.objectContaining({ status: 204, responseBytes: 0, bodyMs: expect.any(Number) })
      );
    } else
      expect(warning).toHaveBeenCalledWith(
        '[Nous] Failed to cancel an incomplete project import.',
        expect.any(ProjectStorageError)
      );
  } finally {
    warning.mockRestore();
  }
});

test('cancellation waits for accepted source work to settle before returning to draft cleanup', async () => {
  const controller = new AbortController();
  const deleted = createDeferred();
  const stop = createDeferred();
  let settled = false;
  let cancellationPolls = 0;
  let deleting = false;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/config'))
      return new Response(
        JSON.stringify({
          success: true,
          config: {
            import: {
              maxChunkBytes: 16_000_000,
              maxChunkCount: 32,
              maxSerializedBytes: 280_000_000,
              requestTimeoutMs: 120000,
              directMaxBytes: 20_000_000,
            },
          },
        })
      );
    if (init?.method === 'PUT')
      return new Response(JSON.stringify({ success: true }), { status: 202 });
    if (url.endsWith('/complete')) {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    }
    if (init?.method === 'DELETE') {
      deleting = true;
      deleted.resolve();
      return new Response(JSON.stringify({ success: true, uploadStatus: 'finalizing' }), {
        status: 202,
      });
    }
    if (deleting) {
      cancellationPolls++;
      await stop.promise;
      return new Response(
        JSON.stringify({ success: false, code: 'SOURCE_PREPARATION_CANCELLED' }),
        { status: 409 }
      );
    }
    throw new Error('Unexpected request');
  });
  const saving = new HttpProjectRepository('http://localhost:3301')
    .saveProject(buildPdfSnapshot(), {
      sourceFiles: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
      signal: controller.signal,
    })
    .catch(error => {
      settled = true;
      return error;
    });
  try {
    await deleted.promise;
    await expect.poll(() => cancellationPolls).toBe(1);
    expect(settled).toBe(false);
  } finally {
    stop.resolve();
    await saving;
  }
  expect(settled).toBe(true);
});

test('source parts keep the approved request deadline beyond the ordinary 15-second save window', async () => {
  vi.useFakeTimers();
  const started = createDeferred();
  const finish = createDeferred();
  let observed: AbortSignal | undefined;
  const snapshot = buildPdfSnapshot();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/config'))
      return new Response(
        JSON.stringify({
          success: true,
          config: {
            import: {
              maxChunkBytes: 16_000_000,
              maxChunkCount: 32,
              maxSerializedBytes: 280_000_000,
              requestTimeoutMs: 120000,
              directMaxBytes: 20_000_000,
            },
          },
        })
      );
    if (init?.method === 'PUT') {
      observed = init.signal ?? undefined;
      started.resolve();
      await finish.promise;
      return new Response(JSON.stringify({ success: true }), { status: 202 });
    }
    return new Response(
      JSON.stringify({ success: true, complete: true, meta: { id: snapshot.id }, snapshot })
    );
  });
  const saving = new HttpProjectRepository('http://localhost:3301').saveProject(snapshot, {
    sourceFiles: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
  });
  try {
    await started.promise;
    await vi.advanceTimersByTimeAsync(15_001);
    expect(observed?.aborted).toBe(false);
  } finally {
    finish.resolve();
    await saving;
    vi.useRealTimers();
  }
});

test('cancellation releases the client when finalizing outlives the existing request deadline', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const deleted = createDeferred();
  let settled = false;
  let cancellationPolls = 0;
  let deleting = false;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/config'))
      return new Response(
        JSON.stringify({
          success: true,
          config: {
            import: {
              maxChunkBytes: 16_000_000,
              maxChunkCount: 32,
              maxSerializedBytes: 280_000_000,
              requestTimeoutMs: 120000,
              directMaxBytes: 20_000_000,
            },
          },
        })
      );
    if (init?.method === 'PUT')
      return new Response(JSON.stringify({ success: true }), { status: 202 });
    if (url.endsWith('/complete')) {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    }
    if (init?.method === 'DELETE') {
      deleting = true;
      deleted.resolve();
      return new Response(JSON.stringify({ success: true, uploadStatus: 'finalizing' }), {
        status: 202,
      });
    }
    if (deleting) {
      cancellationPolls++;
      if (!settled)
        return new Response(JSON.stringify({ success: true, uploadStatus: 'finalizing' }));
      return new Response(
        JSON.stringify({ success: false, code: 'SOURCE_PREPARATION_CANCELLED' }),
        { status: 409 }
      );
    }
    throw new Error('Unexpected request');
  });
  const saving = new HttpProjectRepository('http://localhost:3301')
    .saveProject(buildPdfSnapshot(), {
      sourceFiles: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
      signal: controller.signal,
    })
    .catch(error => {
      settled = true;
      return error;
    });
  try {
    await deleted.promise;
    await vi.advanceTimersByTimeAsync(15_001);
    expect(cancellationPolls).toBeGreaterThan(0);
    expect(settled).toBe(true);
  } finally {
    settled = true;
    await vi.runOnlyPendingTimersAsync();
    await saving;
    vi.useRealTimers();
  }
  expect(settled).toBe(true);
});

test('rejects oversized source metadata before starting any transfer', async () => {
  setRenderingLocaleOverride('it');
  const snapshot = buildPdfSnapshot();
  snapshot.title = 'x'.repeat(SOURCE_TRANSFER_LIMITS.maxPartBytes);
  await expect(
    new HttpProjectRepository('http://localhost:3301').saveProject(snapshot, {
      sourceFiles: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
    })
  ).rejects.toMatchObject({
    code: 'source-preparation-failed',
    message: 'I metadati delle fonti superano il limite di caricamento.',
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  {
    locale: 'it' as const,
    message: PDF_SCANNED_PAGE_LIMIT_MESSAGE,
  },
  {
    locale: 'en' as const,
    message: 'There is too much scanned material for one course. Select only the parts you need.',
  },
])('shows the safe scanned-course limit in $locale', async ({ locale, message }) => {
  setRenderingLocaleOverride(locale);
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: false,
        code: 'PDF_SCANNED_PAGE_LIMIT',
        error: 'private provider details',
      }),
      { status: 422 }
    )
  );
  await expect(
    new HttpProjectRepository('http://localhost:3301').listFolders()
  ).rejects.toMatchObject({
    code: 'scanned-page-limit',
    message,
  });
});

test('retains failed physical pages in the terminal all-unusable source response', async () => {
  setRenderingLocaleOverride('it');
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: false,
        code: 'SOURCE_PREPARATION_UNUSABLE',
        sourceWarnings: [{ name: 'scan.pdf', reason: 'no-usable-text', failedPages: [2, 7] }],
      }),
      { status: 422 }
    )
  );
  await expect(
    new HttpProjectRepository('http://localhost:3301').listFolders()
  ).rejects.toMatchObject({
    code: 'source-preparation-failed',
    sourceWarnings: [
      {
        name: 'scan.pdf',
        reason: 'no-usable-text',
        message: 'Trascrizione non riuscita per le pagine: 2, 7.',
      },
    ],
  });
});

test('reopening a preparing project follows its operation and reports progress without uploading again', async () => {
  const uploadId = crypto.randomUUID();
  const snapshot = buildPdfSnapshot();
  const progress = { step: 'pdf-transcription', documentName: 'scan.pdf', completed: 0, total: 1 };
  const onSourceProgress = vi.fn();
  let statuses = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (url.endsWith(`/projects/${snapshot.id}`))
      return new Response(
        JSON.stringify({ success: true, project: null, preparation: { uploadId, progress } })
      );
    expect(url).toContain(`/chunks/${uploadId}`);
    statuses++;
    return new Response(
      JSON.stringify(
        statuses === 1
          ? { success: true, uploadStatus: 'finalizing', progress }
          : { success: true, complete: true, meta: { id: snapshot.id, revision: 2 }, snapshot }
      )
    );
  });
  const loaded = await new HttpProjectRepository('http://localhost:3301').loadProjectWithRevision(
    snapshot.id,
    { onSourceProgress }
  );
  expect(loaded?.revision).toBe(2);
  expect(loaded?.snapshot.id).toBe(snapshot.id);
  expect(onSourceProgress).toHaveBeenCalledWith(progress);
  expect(statuses).toBe(2);
});

test('a network blip during preparation keeps following the accepted operation without cancelling it', async () => {
  const uploadId = crypto.randomUUID();
  const snapshot = buildPdfSnapshot();
  let statuses = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (url.endsWith(`/projects/${snapshot.id}`))
      return new Response(JSON.stringify({ success: true, preparation: { uploadId } }));
    statuses++;
    if (statuses === 1) throw new TypeError('synthetic network disconnection');
    return new Response(
      JSON.stringify({
        success: true,
        complete: true,
        meta: { id: snapshot.id, revision: 2 },
        snapshot,
      })
    );
  });
  const loaded = await new HttpProjectRepository('http://localhost:3301').loadProjectWithRevision(
    snapshot.id
  );
  expect(loaded?.snapshot.id).toBe(snapshot.id);
  expect(statuses).toBe(2);
});

test('course response progress keeps the existing deadline alive, but a stalled body aborts', async () => {
  vi.useFakeTimers();
  try {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockImplementationOnce((_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      });
      init.signal.addEventListener('abort', () =>
        body.error(new DOMException('Aborted', 'AbortError'))
      );
      return Promise.resolve(
        new Response(stream, { headers: { 'content-type': 'application/json' } })
      );
    });
    const loaded = new HttpProjectRepository('http://backend.test').loadProjectWithRevision(
      'course'
    );
    const result = loaded.then(
      value => ({ value }),
      error => ({ error })
    );
    await vi.advanceTimersByTimeAsync(0);
    body.enqueue(new TextEncoder().encode('{"success":true,'));
    await vi.advanceTimersByTimeAsync(10_000);
    body.enqueue(new TextEncoder().encode('"project":null'));
    await vi.advanceTimersByTimeAsync(10_000);
    body.enqueue(new TextEncoder().encode('}'));
    body.close();
    expect(await result).toEqual({ value: null });

    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    const stalled = new HttpProjectRepository('http://backend.test').loadProjectWithRevision(
      'course'
    );
    const rejection = expect(stalled).rejects.toBeInstanceOf(ProjectStorageError);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  } finally {
    vi.useRealTimers();
  }
});

test('a response that stops after its headers and first bytes still times out', async () => {
  vi.useFakeTimers();
  try {
    fetchMock.mockImplementationOnce((_url, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"success":true,'));
              init.signal.addEventListener('abort', () =>
                controller.error(new DOMException('Aborted', 'AbortError'))
              );
            },
          })
        )
      )
    );
    const rejected = expect(
      new HttpProjectRepository('http://backend.test').loadProjectWithRevision('course')
    ).rejects.toBeInstanceOf(ProjectStorageError);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('incremental response decoding preserves UTF-8 split between network chunks', async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ success: true, folders: [{ id: 'folder', name: 'caffè ☕' }] })
  );
  fetchMock.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      })
    )
  );
  await expect(new HttpProjectRepository('http://backend.test').listFolders()).resolves.toEqual([
    { id: 'folder', name: 'caffè ☕' },
  ]);
});

test('deferred writes fail safely on an older server without retrying an unprotected PUT', async () => {
  const snapshot = {
    ...buildPdfSnapshot(),
    source: null,
    documentIndex: {
      kind: 'pdf-text-index' as const,
      parsedAt: '2026-10-21',
      textDeferred: true as const,
      chunks: [],
    },
  };
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ success: false, error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  const repository = new HttpProjectRepository('http://backend.test');
  await expect(repository.saveProject(snapshot, { expectedRevision: 1 })).rejects.toBeInstanceOf(
    ProjectStorageError
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe(
    'http://backend.test/api/projects/projects/pdf-project/deferred'
  );
});

test('first-use text follows a running source preparation with the full-text contract', async () => {
  const snapshot: ProjectSnapshot = {
    ...buildPdfSnapshot(),
    documentIndex: {
      kind: 'pdf-text-index',
      parsedAt: '2026-10-21',
      chunks: [
        {
          id: 'segment',
          text: 'Prepared source text',
          headingPath: [],
          sequence: 0,
          startOffset: 0,
          endOffset: 20,
        },
      ],
    },
  };
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/projects/pdf-project'))
      return new Response(
        JSON.stringify({ success: true, preparation: { uploadId: 'running-preparation' } })
      );
    const full = new URL(url).searchParams.get('documentText') === 'full';
    return new Response(
      JSON.stringify({
        success: true,
        complete: true,
        meta: { id: snapshot.id, revision: 2 },
        snapshot: full
          ? snapshot
          : {
              ...snapshot,
              documentIndex: { ...snapshot.documentIndex, textDeferred: true, chunks: [] },
            },
      })
    );
  });
  const loaded = await new HttpProjectRepository('http://backend.test').loadProjectWithRevision(
    snapshot.id,
    { includeDocumentText: true }
  );
  expect(loaded?.snapshot.documentIndex?.chunks[0].text).toBe('Prepared source text');
  expect(loaded?.snapshot.documentIndex?.textDeferred).toBeUndefined();
});
