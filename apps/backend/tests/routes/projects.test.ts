import {
  createProjectBackupArchive,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
} from '@shared/projectBackupArchive';
import { PROJECT_API_ERROR_CODE, PROJECT_PATCH_REBASE_MODE } from '@shared/projectContract';
import { PROJECT_IMPORT_BINARY_KIND } from '@shared/projectImportContract';
import JSZip from 'jszip';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import { LibrarySiblingSetChangedError } from '../../src/projects/librarySiblingOrder.js';
import { setProjectStoreForTesting } from '../../src/projects/projectStore.js';
import {
  SourceArchivePreparationCapacityError,
  SourceArchivePreparationError,
  SourceArchiveUnusableError,
} from '../../src/projects/sourceArchive.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import { createSupabaseTestToken } from '../helpers/auth.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

let store: InMemoryProjectStore;
let previousLocalUserId: string | undefined;

const createSnapshot = (id: string, title: string, updatedAt = '2026-04-26T10:00:00.000Z') =>
  ({
    id,
    version: '4.1',
    sourceKind: 'document',
    state: 'READING',
    learningPlan: {
      title,
      sections: [{ isCompleted: true }, { isCompleted: false }],
    },
    source: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    createdAt: '2026-04-26T09:00:00.000Z',
    updatedAt,
    lastOpenedAt: updatedAt,
  }) satisfies ProjectSnapshot;

const createModuleSnapshot = (id: string, title: string, updatedAt = '2026-04-26T10:00:00.000Z') =>
  ({
    ...createSnapshot(id, title, updatedAt),
    learningPlan: {
      title,
      summary: 'Corso organizzato a moduli',
      modules: [
        {
          id: 'module-1',
          title: 'Modulo 1',
          children: [
            {
              id: 'lesson-1',
              kind: 'lesson',
              title: 'Prima lezione',
              description: 'Introduzione',
              isCompleted: true,
              type: 'core',
            },
            {
              id: 'exercise-1',
              kind: 'exercise',
              title: 'Esercizio applicativo',
              status: 'available',
            },
          ],
        },
        {
          id: 'module-2',
          title: 'Modulo 2',
          children: [
            {
              id: 'lesson-2',
              kind: 'lesson',
              title: 'Seconda lezione',
              description: 'Approfondimento',
              isCompleted: false,
              type: 'core',
            },
          ],
        },
      ],
      applicationExercisePlanningStatus: 'not-run',
    },
  }) satisfies ProjectSnapshot;

const createPdfSnapshot = (id: string, title: string): ProjectSnapshot => ({
  ...createSnapshot(id, title),
  source: {
    file: {
      data: Buffer.from('persisted-pdf-source').toString('base64'),
      mimeType: 'application/pdf',
      name: 'source.pdf',
    },
    kind: 'pdf',
  },
});

describe('/api/projects', () => {
  beforeEach(() => {
    previousLocalUserId = process.env.LOCAL_USER_ID;
    store = new InMemoryProjectStore();
    setProjectStoreForTesting(store);
  });

  afterEach(() => {
    setProjectStoreForTesting(null);
    if (previousLocalUserId === undefined) {
      delete process.env.LOCAL_USER_ID;
    } else {
      process.env.LOCAL_USER_ID = previousLocalUserId;
    }
  });

  test('exposes the configured project import transfer contract', async () => {
    const response = await request(createApp()).get('/api/projects/config');

    expect(response.status).toBe(200);
    expect(response.body.config.import).toMatchObject({
      directMaxBytes: 20_000_000,
      maxChunkBytes: 16_000_000,
      maxChunkCount: 32,
      maxSerializedBytes: 280_000_000,
      requestTimeoutMs: 120_000,
    });
  });

  test('saves, lists, loads, exports, touches, and deletes projects', async () => {
    const app = createApp();
    const snapshot = createSnapshot('project-1', 'Corso server');

    const saveResponse = await request(app).put('/api/projects/projects/project-1').send({
      snapshot,
    });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body.meta).toMatchObject({
      id: 'project-1',
      title: 'Corso server',
      lessonCount: 2,
      completedCount: 1,
    });

    const listResponse = await request(app).get('/api/projects/projects');
    expect(listResponse.body.projects).toHaveLength(1);

    const loadResponse = await request(app).get('/api/projects/projects/project-1');
    expect(loadResponse.body.project).toMatchObject({
      id: 'project-1',
      learningPlan: { title: 'Corso server' },
    });

    const exportResponse = await request(app).post('/api/projects/projects/project-1/export');
    expect(exportResponse.body.data).toMatchObject({ id: 'project-1' });

    const touchResponse = await request(app).post('/api/projects/projects/project-1/touch');
    expect(touchResponse.status).toBe(200);
    const touchedListResponse = await request(app).get('/api/projects/projects');
    expect(touchedListResponse.body.projects[0].revision).toBe(saveResponse.body.meta.revision);

    const deleteResponse = await request(app).delete('/api/projects/projects/project-1');
    expect(deleteResponse.status).toBe(200);

    const emptyListResponse = await request(app).get('/api/projects/projects');
    expect(emptyListResponse.body.projects).toEqual([]);
  });

  test('returns a retryable 429 when ZIP preparation capacity is busy', async () => {
    vi.spyOn(store, 'saveProject').mockRejectedValue(new SourceArchivePreparationCapacityError());

    const response = await request(createApp())
      .put('/api/projects/projects/busy-project')
      .send({ snapshot: createSnapshot('busy-project', 'Archivio occupato') });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      code: PROJECT_API_ERROR_CODE.sourceArchiveBusy,
      error: 'È già in corso la preparazione di un archivio ZIP. Riprova tra poco.',
      success: false,
    });
  });

  test('returns structured PDF details when an archive has no usable text', async () => {
    vi.spyOn(store, 'saveProject').mockRejectedValue(
      new SourceArchiveUnusableError([
        { path: 'scans/a.pdf', reason: 'no-usable-text' },
        { path: 'broken/b.pdf', reason: 'parser-failed' },
      ])
    );

    const response = await request(createApp())
      .put('/api/projects/projects/unusable-project')
      .send({ snapshot: createSnapshot('unusable-project', 'Archivio inutilizzabile') });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      code: PROJECT_API_ERROR_CODE.sourceArchiveUnusable,
      error: 'L’archivio non contiene alcun testo utilizzabile.',
      sourceWarnings: [
        { path: 'scans/a.pdf', reason: 'no-usable-text' },
        { path: 'broken/b.pdf', reason: 'parser-failed' },
      ],
      success: false,
    });
  });

  test('returns a stable code when archive preparation fails before persistence', async () => {
    vi.spyOn(store, 'saveProject').mockRejectedValue(
      new SourceArchivePreparationError('preparation deadline exceeded')
    );

    const response = await request(createApp())
      .put('/api/projects/projects/invalid-archive-project')
      .send({ snapshot: createSnapshot('invalid-archive-project', 'Archivio non valido') });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      code: PROJECT_API_ERROR_CODE.sourceArchiveInvalid,
      error: 'Invalid source archive: preparation deadline exceeded.',
      success: false,
    });
  });

  test('rejects an incomplete canonical snapshot before persistence', async () => {
    const response = await request(createApp())
      .put('/api/projects/projects/incomplete-project')
      .send({
        snapshot: {
          id: 'incomplete-project',
          projectFormatVersion: 1,
          title: 'Incomplete project',
        },
      });

    expect(response.status).toBe(400);
    expect(store.fullSaveCount).toBe(0);
    expect((await request(createApp()).get('/api/projects/projects')).body.projects).toEqual([]);
  });

  test('returns 404 instead of recreating a course deleted by another session', async () => {
    const app = createApp();
    const snapshot = createSnapshot('deleted-project', 'Corso da eliminare');
    const saveResponse = await request(app)
      .put('/api/projects/projects/deleted-project')
      .send({ snapshot });
    expect(saveResponse.status).toBe(200);

    const deleteResponse = await request(app).delete('/api/projects/projects/deleted-project');
    expect(deleteResponse.status).toBe(200);

    const stalePut = await request(app)
      .put('/api/projects/projects/deleted-project')
      .send({ expectedRevision: 1, snapshot: { ...snapshot, title: 'Scrittura tardiva' } });
    const stalePatch = await request(app)
      .patch('/api/projects/projects/deleted-project')
      .send({ expectedRevision: 1, patch: { title: 'Patch tardiva' } });
    const staleFavorite = await request(app)
      .patch('/api/projects/projects/deleted-project/favorite')
      .send({ isFavorite: true });
    const staleTouch = await request(app).post('/api/projects/projects/deleted-project/touch');
    const staleCover = await request(app)
      .post('/api/projects/projects/deleted-project/cover')
      .send({
        cover: { data: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'deleted-cover.png' },
      });

    expect(stalePut.status).toBe(404);
    expect(stalePatch.status).toBe(404);
    expect(staleFavorite.status).toBe(404);
    expect(staleTouch.status).toBe(404);
    expect(staleCover.status).toBe(404);
    const listResponse = await request(app).get('/api/projects/projects');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.projects).toEqual([]);
  });

  test('round-trips explicit project titles through JSON and multipart saves', async () => {
    const app = createApp();
    const jsonSnapshot = {
      ...createSnapshot('json-title-project', 'Titolo del piano JSON'),
      title: 'Titolo esplicito JSON',
    } satisfies ProjectSnapshot;

    const jsonResponse = await request(app)
      .put('/api/projects/projects/json-title-project')
      .send({ snapshot: jsonSnapshot });

    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.body.snapshot.title).toBe('Titolo esplicito JSON');

    const archive = new JSZip();
    archive.file('main.ts', 'export const ready = true;');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    const multipartSnapshot = {
      ...createSnapshot('multipart-title-project', 'Titolo del piano multipart'),
      title: 'Titolo esplicito multipart',
      sourceKind: 'codebase' as const,
      source: {
        file: { data: '', mimeType: 'application/zip', name: 'source.zip' },
        index: { entries: [] },
        kind: 'archive',
        name: 'source.zip',
      },
    };

    const multipartResponse = await request(app)
      .put('/api/projects/projects/multipart-title-project')
      .field('snapshot', JSON.stringify(multipartSnapshot))
      .attach('archive', Buffer.from(archiveBytes), {
        contentType: 'application/zip',
        filename: 'source.zip',
      });

    expect(multipartResponse.status).toBe(200);
    expect(multipartResponse.body.snapshot.title).toBe('Titolo esplicito multipart');
  });

  test('stores favorites on the server with last-arrival-wins updates', async () => {
    const app = createApp();
    await request(app)
      .put('/api/projects/projects/favorite-project')
      .send({ snapshot: createSnapshot('favorite-project', 'Corso preferito') });

    const favoriteResponse = await request(app)
      .patch('/api/projects/projects/favorite-project/favorite')
      .send({ isFavorite: true });
    const unfavoriteResponse = await request(app)
      .patch('/api/projects/projects/favorite-project/favorite')
      .send({ isFavorite: false });

    expect(favoriteResponse.body.meta.isFavorite).toBe(true);
    expect(unfavoriteResponse.body.meta).toMatchObject({
      isFavorite: false,
      revision: 3,
    });
    const listResponse = await request(app).get('/api/projects/projects');
    expect(listResponse.body.projects[0].isFavorite).toBe(false);
  });

  test('keeps the newest project version when stale clients save later', async () => {
    const app = createApp();
    const newerSnapshot = createSnapshot('project-1', 'Versione nuova', '2026-04-26T12:00:00.000Z');
    const staleSnapshot = createSnapshot(
      'project-1',
      'Versione vecchia',
      '2026-04-26T11:00:00.000Z'
    );

    await request(app).put('/api/projects/projects/project-1').send({ snapshot: newerSnapshot });
    const staleResponse = await request(app)
      .put('/api/projects/projects/project-1')
      .send({ snapshot: staleSnapshot });

    expect(staleResponse.body.meta.title).toBe('Versione nuova');

    const loadResponse = await request(app).get('/api/projects/projects/project-1');
    expect(loadResponse.body.project.learningPlan.title).toBe('Versione nuova');
  });

  test('stores PDF bytes separately and only reattaches them for source download or export', async () => {
    const app = createApp();
    const pdfData = 'JVBERi0xLjQKZmFrZS1wZGY=';
    const snapshot = {
      ...createSnapshot('pdf-project', 'Corso PDF'),
      source: {
        kind: 'pdf',
        file: {
          name: 'dispensa.pdf',
          mimeType: 'application/pdf',
          data: pdfData,
        },
      },
    } satisfies ProjectSnapshot;

    const saveResponse = await request(app)
      .put('/api/projects/projects/pdf-project')
      .send({ snapshot });
    expect(saveResponse.status).toBe(200);

    const loadResponse = await request(app).get('/api/projects/projects/pdf-project');
    expect(loadResponse.status).toBe(200);
    expect(loadResponse.body.project.source).toMatchObject({
      kind: 'pdf',
      file: {
        name: 'dispensa.pdf',
        mimeType: 'application/pdf',
        data: '',
      },
      ref: {
        byteSize: 17,
        hash: expect.any(String),
        id: expect.any(String),
      },
    });

    const sourceResponse = await request(app).get('/api/projects/projects/pdf-project/source');
    expect(sourceResponse.status).toBe(200);
    expect(sourceResponse.body.source).toEqual({
      name: 'dispensa.pdf',
      mimeType: 'application/pdf',
      data: pdfData,
    });

    const exportResponse = await request(app).post('/api/projects/projects/pdf-project/export');
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.body.data.source.file.data).toBe(pdfData);

    const importResponse = await request(app)
      .post('/api/projects/import')
      .send({ data: { ...exportResponse.body.data, id: 'imported-pdf-project' } });
    expect(importResponse.status).toBe(200);
    expect(importResponse.body.snapshot.source.file.data).toBe('');
    const importedSourceResponse = await request(app).get(
      '/api/projects/projects/imported-pdf-project/source'
    );
    expect(importedSourceResponse.body.source.data).toBe(pdfData);

    const chunkedImportData = {
      ...exportResponse.body.data,
      id: 'chunked-import-project',
      documentIndex: { marker: 'before after' },
    };
    const serializedImport = JSON.stringify(chunkedImportData);
    const uploadId = '123e4567-e89b-42d3-a456-426614174000';
    const splitAt = serializedImport.indexOf('before after') + 'before '.length;
    const lastChunkResponse = await request(app)
      .put(`/api/projects/import/chunks/${uploadId}/1?chunkCount=2`)
      .set('Content-Type', 'text/plain')
      .send(serializedImport.slice(splitAt));
    expect(lastChunkResponse.status).toBe(202);
    expect(lastChunkResponse.body).toEqual({
      success: true,
      complete: false,
      ready: false,
      receivedCount: 1,
    });

    const duplicateChunkResponse = await request(app)
      .put(`/api/projects/import/chunks/${uploadId}/1?chunkCount=2`)
      .set('Content-Type', 'text/plain')
      .send(serializedImport.slice(splitAt));
    expect(duplicateChunkResponse.status).toBe(202);
    expect(duplicateChunkResponse.body.receivedCount).toBe(1);

    const changedDuplicateResponse = await request(app)
      .put(`/api/projects/import/chunks/${uploadId}/1?chunkCount=2`)
      .set('Content-Type', 'text/plain')
      .send('different data');
    expect(changedDuplicateResponse.status).toBe(400);

    const prematureCompletionResponse = await request(app).post(
      `/api/projects/import/chunks/${uploadId}/complete`
    );
    expect(prematureCompletionResponse.status).toBe(400);

    const inconsistentChunkResponse = await request(app)
      .put(`/api/projects/import/chunks/${uploadId}/0?chunkCount=3`)
      .set('Content-Type', 'text/plain')
      .send(serializedImport.slice(0, splitAt));
    expect(inconsistentChunkResponse.status).toBe(400);

    const firstChunkResponse = await request(app)
      .put(`/api/projects/import/chunks/${uploadId}/0?chunkCount=2`)
      .set('Content-Type', 'text/plain')
      .send(serializedImport.slice(0, splitAt));
    expect(firstChunkResponse.status).toBe(202);
    expect(firstChunkResponse.body).toEqual({
      success: true,
      complete: false,
      ready: true,
      receivedCount: 2,
    });

    const finalChunkResponse = await request(app).post(
      `/api/projects/import/chunks/${uploadId}/complete`
    );
    expect(finalChunkResponse.status).toBe(200);
    expect(finalChunkResponse.body.snapshot).toMatchObject({ id: 'chunked-import-project' });
    expect(finalChunkResponse.body.snapshot.documentIndex).toEqual({ marker: 'before after' });
    expect(finalChunkResponse.body.snapshot.source.file.data).toBe('');

    const retriedCompletionResponse = await request(app).post(
      `/api/projects/import/chunks/${uploadId}/complete`
    );
    expect(retriedCompletionResponse.status).toBe(200);
    expect(retriedCompletionResponse.body.snapshot.id).toBe('chunked-import-project');

    const completedStatusResponse = await request(app).get(
      `/api/projects/import/chunks/${uploadId}`
    );
    expect(completedStatusResponse.status).toBe(200);
    expect(completedStatusResponse.body).toMatchObject({
      complete: true,
      uploadStatus: 'completed',
    });

    expect(JSON.stringify(store.readStoredSnapshot('local-user', 'pdf-project'))).not.toContain(
      pdfData
    );
  });

  test('imports a binary source archive in bounded chunks', async () => {
    const app = createApp();
    const arrayBufferSpy = vi.spyOn(globalThis.Request.prototype, 'arrayBuffer');
    const uploadId = '223e4567-e89b-42d3-a456-426614174000';
    const sourceZip = new JSZip();
    sourceZip.file('main.ts', 'export const ready = true;');
    const sourceBytes = Buffer.from(await sourceZip.generateAsync({ type: 'uint8array' }));
    const splitAt = Math.ceil(sourceBytes.length / 2);
    const snapshot = {
      ...createSnapshot('binary-import-project', 'Corso archivio'),
      sourceKind: 'codebase' as const,
      source: {
        file: { data: '', mimeType: 'application/zip', name: 'engine.zip' },
        index: { entries: [] },
        kind: 'archive',
        name: 'engine.zip',
      },
    };

    for (let chunkIndex = 0; chunkIndex < 2; chunkIndex += 1) {
      const response = await request(app)
        .put(`/api/projects/import/chunks/${uploadId}/${chunkIndex}?chunkCount=2`)
        .set('Content-Type', 'application/octet-stream')
        .send(
          sourceBytes.subarray(
            chunkIndex === 0 ? 0 : splitAt,
            chunkIndex === 0 ? splitAt : undefined
          )
        );
      expect(response.status).toBe(202);
    }

    const response = await request(app)
      .post(`/api/projects/import/chunks/${uploadId}/complete`)
      .send({
        payloadKind: PROJECT_IMPORT_BINARY_KIND.sourceArchive,
        snapshot,
        sourceFile: { mimeType: 'application/zip', name: 'engine.zip' },
      });
    expect(response.status).toBe(200);
    expect(response.body.snapshot).toMatchObject({ id: 'binary-import-project' });
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  test('rejects chunked archive completion when the project revision changed during upload', async () => {
    const app = createApp();
    const projectId = 'concurrent-archive-project';
    const concurrentSourceData = 'JVBERi0xLjQKc291cmNlLWZyb20tcmV2aXNpb24tdHdv';
    const initialSnapshot = {
      ...createSnapshot(projectId, 'Corso iniziale'),
      source: {
        kind: 'pdf' as const,
        file: {
          data: concurrentSourceData,
          mimeType: 'application/pdf',
          name: 'revisione-due.pdf',
        },
      },
    } satisfies ProjectSnapshot;
    const initialSave = await request(app)
      .put(`/api/projects/projects/${projectId}`)
      .send({ snapshot: initialSnapshot });
    expect(initialSave.body.meta.revision).toBe(1);

    const sourceZip = new JSZip();
    sourceZip.file('main.ts', 'export const ready = true;');
    const sourceBytes = Buffer.from(await sourceZip.generateAsync({ type: 'uint8array' }));
    const uploadId = '623e4567-e89b-42d3-a456-426614174000';
    const chunkResponse = await request(app)
      .put(`/api/projects/import/chunks/${uploadId}/0?chunkCount=1&expectedRevision=1`)
      .set('Content-Type', 'application/octet-stream')
      .send(sourceBytes);
    expect(chunkResponse.status).toBe(202);

    const concurrentPatch = await request(app)
      .patch(`/api/projects/projects/${projectId}`)
      .send({
        expectedRevision: 1,
        patch: { activeSectionId: 'saved-concurrently' },
      });
    expect(concurrentPatch.body.meta.revision).toBe(2);

    const archiveSnapshot = {
      ...initialSnapshot,
      sourceKind: 'codebase' as const,
      source: {
        file: { data: '', mimeType: 'application/zip', name: 'engine.zip' },
        index: { entries: [] },
        kind: 'archive',
        name: 'engine.zip',
      },
    };
    const completionResponse = await request(app)
      .post(`/api/projects/import/chunks/${uploadId}/complete`)
      .send({
        payloadKind: PROJECT_IMPORT_BINARY_KIND.sourceArchive,
        snapshot: archiveSnapshot,
        sourceFile: { mimeType: 'application/zip', name: 'engine.zip' },
      });

    expect(completionResponse.status).toBe(409);
    expect(completionResponse.body.code).toBe(PROJECT_API_ERROR_CODE.revisionConflict);
    const loadResponse = await request(app).get(`/api/projects/projects/${projectId}`);
    expect(loadResponse.body).toMatchObject({
      project: {
        activeSectionId: 'saved-concurrently',
        source: { file: { data: '', name: 'revisione-due.pdf' }, kind: 'pdf' },
      },
      revision: 2,
    });
    const sourceResponse = await request(app).get(`/api/projects/projects/${projectId}/source`);
    expect(sourceResponse.body.source).toMatchObject({
      data: concurrentSourceData,
      name: 'revisione-due.pdf',
    });
  });

  test('rejects unsupported chunk content types before a generic body parser can buffer them', async () => {
    const app = createApp();
    const uploadId = '423e4567-e89b-42d3-a456-426614174000';

    const response = await request(app)
      .put(`/api/projects/import/chunks/${uploadId}/0?chunkCount=1`)
      .set('Content-Type', 'application/json')
      .send({ unexpected: 'body' });

    expect(response.status).toBe(415);
    expect(response.body).toEqual({
      error: 'Tipo di contenuto del blocco di importazione non supportato.',
      success: false,
    });
  });

  test('imports a self-contained project backup with an explicit binary payload kind', async () => {
    const app = createApp();
    const uploadId = '323e4567-e89b-42d3-a456-426614174000';
    const targetProjectId = 'restored-project';
    const archivedSnapshot = createSnapshot('archived-project', 'Corso ripristinato');
    archivedSnapshot.documentAssets = {
      imageCount: 1,
      kind: 'pdf',
      parsedAt: '2026-04-26T09:20:00.000Z',
      usedImages: [
        {
          dataUrl: 'data:image/png;base64,aW1hZ2U=',
          id: 'image-1',
          mimeType: 'image/png',
          sourceOrder: 0,
          textAfter: '',
          textBefore: '',
        },
      ],
    };
    archivedSnapshot.learningPlan.sections[0] = {
      ...archivedSnapshot.learningPlan.sections[0],
      generatedVisuals: [
        {
          code: '<svg />',
          createdAt: '2026-04-26T09:20:00.000Z',
          id: 'visual-1',
          kind: 'svg',
          title: 'Visuale generato',
        },
      ],
      id: 'lesson-1',
      imageRefs: [{ alt: 'Immagine PDF', assetId: 'image-1' }],
      annotations: [
        {
          anchor: { kind: 'lesson' },
          artifactRefs: [
            {
              artifactId: 'archived-project:lesson-1:generated-visual:visual-1',
              kind: 'generated-visual',
              title: 'Visuale generato',
            },
            {
              artifactId: 'archived-project:lesson-1:pdf-image:image-1',
              kind: 'pdf-image',
              title: 'Immagine PDF',
            },
            {
              artifactId: 'archived-project:lesson-1:future-asset:asset-1',
              kind: 'future-asset',
              title: 'Artefatto futuro',
            },
          ],
          createdAt: '2026-04-26T09:30:00.000Z',
          id: 'annotation-1',
          note: 'Questa nota deve restare invariata.',
          updatedAt: '2026-04-26T09:30:00.000Z',
        },
      ],
    };
    const backupBytes = await createProjectBackupArchive(
      {
        cover: {
          data: Buffer.from('cover bytes').toString('base64'),
          mimeType: 'image/png',
          name: 'cover.png',
        },
        project: archivedSnapshot,
      },
      {
        invalidArchiveMessage: 'Invalid project backup.',
        maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
        maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
        maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
      }
    );

    const chunkResponse = await request(app)
      .put(`/api/projects/import/chunks/${uploadId}/0?chunkCount=1`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(backupBytes));
    expect(chunkResponse.status).toBe(202);

    const completionResponse = await request(app)
      .post(`/api/projects/import/chunks/${uploadId}/complete`)
      .send({ payloadKind: PROJECT_IMPORT_BINARY_KIND.backup, targetProjectId });

    expect(completionResponse.status).toBe(200);
    expect(completionResponse.body.snapshot).toMatchObject({
      id: targetProjectId,
      learningPlan: { title: 'Corso ripristinato' },
    });
    expect(completionResponse.body.snapshot.learningPlan.sections[0].annotations[0]).toMatchObject({
      artifactRefs: [
        {
          artifactId: `${targetProjectId}:lesson-1:generated-visual:visual-1`,
          kind: 'generated-visual',
        },
        {
          artifactId: `${targetProjectId}:lesson-1:pdf-image:image-1`,
          kind: 'pdf-image',
        },
        {
          artifactId: 'archived-project:lesson-1:future-asset:asset-1',
          kind: 'future-asset',
        },
      ],
      note: 'Questa nota deve restare invariata.',
    });
    const coverResponse = await request(app).get(`/api/projects/projects/${targetProjectId}/cover`);
    expect(coverResponse.body.cover).toEqual({
      data: Buffer.from('cover bytes').toString('base64'),
      mimeType: 'image/png',
      name: 'cover.png',
    });
  });

  test('round-trips every modern course source while snapshots remain byte-free', async () => {
    const app = createApp();
    const sourceFiles = [
      {
        file: {
          data: Buffer.from('first document').toString('base64'),
          mimeType: 'text/plain',
          name: 'notes.txt',
        },
        id: 'source-notes-1',
        position: 0,
      },
      {
        file: {
          data: Buffer.from('second document').toString('base64'),
          mimeType: 'text/plain',
          name: 'notes.txt',
        },
        id: 'source-notes-2',
        position: 1,
      },
    ];

    const embeddedSources = sourceFiles.map(source => ({
      file: { ...source.file, sourceId: source.id },
      hash: source.id,
      id: source.id,
      kind: 'text',
      name: source.file.name,
      outline: [],
      outlineOrigin: 'none',
      position: source.position,
      status: 'ready',
    }));
    const snapshot = {
      ...createSnapshot('multi-source', 'Corso multi-fonte'),
      source: {
        file: embeddedSources[0].file,
        kind: 'document',
        sources: embeddedSources,
      },
    } satisfies ProjectSnapshot;
    const snapshotSave = await request(app)
      .put('/api/projects/projects/multi-source')
      .send({ snapshot });
    expect(snapshotSave.status).toBe(200);
    expect(
      snapshotSave.body.snapshot.source.sources.every(
        (source: { file: { data: string }; ref?: unknown }) => source.file.data === '' && source.ref
      )
    ).toBe(true);

    const storedSnapshot = await request(app).get('/api/projects/projects/multi-source');
    expect(
      storedSnapshot.body.project.source.sources.every(
        (source: { file: { data: string } }) => source.file.data === ''
      )
    ).toBe(true);

    const sourceLoad = await request(app).get('/api/projects/projects/multi-source/sources');
    expect(sourceLoad.status).toBe(200);
    expect(
      sourceLoad.body.sources.map((source: { file: { data: string } }) => source.file.data)
    ).toEqual(sourceFiles.map(source => source.file.data));

    const selectedSourceLoad = await request(app).get(
      '/api/projects/projects/multi-source/sources/source-notes-2'
    );
    expect(selectedSourceLoad.status).toBe(200);
    expect(selectedSourceLoad.body.source).toEqual({
      ...sourceFiles[1]?.file,
      sourceId: 'source-notes-2',
    });

    const exported = await request(app).post('/api/projects/projects/multi-source/export');
    expect(
      exported.body.data.source.sources.map(
        (source: { file: { data: string } }) => source.file.data
      )
    ).toEqual(sourceFiles.map(source => source.file.data));

    const imported = await request(app)
      .post('/api/projects/import')
      .send({ data: { ...exported.body.data, id: 'multi-source-imported' } });
    expect(imported.status).toBe(200);
    expect(
      imported.body.snapshot.source.sources.every(
        (source: { file: { data: string } }) => source.file.data === ''
      )
    ).toBe(true);
    const importedSources = await request(app).get(
      '/api/projects/projects/multi-source-imported/sources'
    );
    expect(
      importedSources.body.sources.map((source: { file: { data: string } }) => source.file.data)
    ).toEqual(sourceFiles.map(source => source.file.data));
  });

  test('does not expose split source-write endpoints', async () => {
    const app = createApp();

    const singularResponse = await request(app)
      .post('/api/projects/projects/project-1/source')
      .send({ source: { data: 'ZmFrZQ==', mimeType: 'text/plain', name: 'source.txt' } });
    const pluralResponse = await request(app)
      .post('/api/projects/projects/project-1/sources')
      .send({ sources: [] });

    expect(singularResponse.status).toBe(404);
    expect(pluralResponse.status).toBe(404);
  });

  test('exposes complete archive metadata and exact source queries without aggregation', async () => {
    const app = createApp();
    const zip = new JSZip();
    const guide = `${Array.from({ length: 30 }, (_, index) => `guide line ${index + 1}`).join(
      '\n'
    )}\nfinal guide sentinel`;
    zip.file('.github/workflows/ci.yml', 'name: CI\nrun: bun run gate');
    zip.file('packages/core/guide.md', guide);
    zip.file('packages/core/index.ts', 'export const engine = true;');
    const archiveBytes = await zip.generateAsync({ compression: 'DEFLATE', type: 'uint8array' });
    const projectId = 'archive-project';

    const archiveSnapshot = {
      ...createSnapshot(projectId, 'Corso archivio'),
      sourceKind: 'codebase' as const,
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
    const saveSnapshotResponse = await request(app)
      .put(`/api/projects/projects/${projectId}`)
      .field('snapshot', JSON.stringify(archiveSnapshot))
      .attach('archive', Buffer.from(archiveBytes), {
        contentType: 'application/zip',
        filename: 'engine.zip',
      });
    expect(saveSnapshotResponse.status).toBe(200);
    expect(saveSnapshotResponse.body.snapshot.source.file.data).toBe('');
    expect(saveSnapshotResponse.body.snapshot.source.ref).toMatchObject({
      id: expect.any(String),
      hash: expect.any(String),
      objectPath: expect.any(String),
    });

    const base64SaveResponse = await request(app)
      .put(`/api/projects/projects/${projectId}`)
      .send({
        snapshot: {
          ...archiveSnapshot,
          source: {
            ...archiveSnapshot.source,
            file: {
              ...archiveSnapshot.source.file,
              data: Buffer.from(archiveBytes).toString('base64'),
            },
          },
        },
      });
    expect(base64SaveResponse.status).toBe(400);

    const detachedSaveResponse = await request(app)
      .put(`/api/projects/projects/${projectId}`)
      .send({ snapshot: saveSnapshotResponse.body.snapshot });
    expect(detachedSaveResponse.status).toBe(200);

    const indexResponse = await request(app).get(
      `/api/projects/projects/${projectId}/source/archive`
    );
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.body.archiveVersion).toEqual(
      expect.objectContaining({
        representationHash: expect.any(String),
        sourceHash: expect.any(String),
        sourceId: expect.any(String),
      })
    );
    const archiveVersion = indexResponse.body.archiveVersion;
    expect(indexResponse.body.archiveIndex.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'directory', path: '.github' }),
        expect.objectContaining({ kind: 'directory', path: 'packages' }),
        expect.objectContaining({
          kind: 'file',
          path: 'packages/core/guide.md',
          preview: Array.from({ length: 24 }, (_, index) => `guide line ${index + 1}`).join('\n'),
        }),
      ])
    );

    const readResponse = await request(app)
      .post(`/api/projects/projects/${projectId}/source/archive/query`)
      .send({ archiveVersion, operation: 'read-file', path: 'packages/core/guide.md' });
    expect(readResponse.status).toBe(200);
    expect(readResponse.body.result).toEqual({
      cursorBytes: 0,
      endByteExclusive: Buffer.byteLength(guide),
      nextCursorBytes: null,
      path: 'packages/core/guide.md',
      text: guide,
      totalBytes: Buffer.byteLength(guide),
    });

    const resumedReadResponse = await request(app)
      .post(`/api/projects/projects/${projectId}/source/archive/query`)
      .send({
        archiveVersion,
        cursorBytes: Buffer.byteLength(guide) - Buffer.byteLength('sentinel'),
        operation: 'read-file',
        path: 'packages/core/guide.md',
      });
    expect(resumedReadResponse.status).toBe(200);
    expect(resumedReadResponse.body.result).toEqual({
      cursorBytes: Buffer.byteLength(guide) - Buffer.byteLength('sentinel'),
      endByteExclusive: Buffer.byteLength(guide),
      nextCursorBytes: null,
      path: 'packages/core/guide.md',
      text: 'sentinel',
      totalBytes: Buffer.byteLength(guide),
    });

    const invalidCursorResponse = await request(app)
      .post(`/api/projects/projects/${projectId}/source/archive/query`)
      .send({
        archiveVersion,
        cursorBytes: Buffer.byteLength(guide) + 1,
        operation: 'read-file',
        path: 'packages/core/guide.md',
      });
    expect(invalidCursorResponse.status).toBe(400);

    const searchResponse = await request(app)
      .post(`/api/projects/projects/${projectId}/source/archive/query`)
      .send({ archiveVersion, operation: 'search-text', query: 'engine' });
    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.result).toEqual([
      {
        column: 14,
        line: 1,
        lineText: 'export const engine = true;',
        path: 'packages/core/index.ts',
      },
    ]);

    const resolveResponse = await request(app)
      .post(`/api/projects/projects/${projectId}/source/archive/query`)
      .send({
        archiveVersion,
        operation: 'resolve-selectors',
        selectors: [
          { kind: 'directory', path: 'packages/core' },
          { kind: 'file', path: 'packages/core/index.ts' },
        ],
      });
    expect(resolveResponse.status).toBe(200);
    expect(resolveResponse.body.result).toEqual([
      { path: 'packages/core/guide.md', text: guide },
      { path: 'packages/core/index.ts', text: 'export const engine = true;' },
    ]);

    const replacementZip = new JSZip();
    replacementZip.file('replacement.txt', 'new source version');
    const replacementBytes = await replacementZip.generateAsync({
      compression: 'DEFLATE',
      type: 'uint8array',
    });
    const replacementSnapshot = {
      ...archiveSnapshot,
      source: {
        ...archiveSnapshot.source,
        file: {
          data: '',
          mimeType: 'application/zip',
          name: 'replacement.zip',
        },
        name: 'replacement.zip',
      },
    };
    const replacementResponse = await request(app)
      .put(`/api/projects/projects/${projectId}`)
      .field('snapshot', JSON.stringify(replacementSnapshot))
      .attach('archive', Buffer.from(replacementBytes), {
        contentType: 'application/zip',
        filename: 'replacement.zip',
      });
    expect(replacementResponse.status).toBe(200);

    const staleReadResponse = await request(app)
      .post(`/api/projects/projects/${projectId}/source/archive/query`)
      .send({ archiveVersion, operation: 'read-file', path: 'packages/core/guide.md' });
    expect(staleReadResponse.status).toBe(409);
    expect(staleReadResponse.body.code).toBe(PROJECT_API_ERROR_CODE.sourceArchiveChanged);
    expect(staleReadResponse.body.error).toMatch(/cambiato|ricarica/iu);

    const exportResponse = await request(app).post(`/api/projects/projects/${projectId}/export`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.body.data.source.file.data).toBe(
      Buffer.from(replacementBytes).toString('base64')
    );
  });

  test('stores raster course covers separately from project snapshots', async () => {
    const app = createApp();
    await request(app)
      .put('/api/projects/projects/project-1')
      .send({ snapshot: createSnapshot('project-1', 'Course with cover') });
    const cover = {
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
      name: 'project-cover.png',
    };

    const saveResponse = await request(app)
      .post('/api/projects/projects/project-1/cover')
      .send({ cover });
    expect(saveResponse.status).toBe(200);

    const loadResponse = await request(app).get('/api/projects/projects/project-1/cover');
    expect(loadResponse.status).toBe(200);
    expect(loadResponse.body.cover).toEqual(cover);

    const invalidResponse = await request(app)
      .post('/api/projects/projects/project-1/cover')
      .send({ cover: { ...cover, mimeType: 'image/svg+xml' } });
    expect(invalidResponse.status).toBe(400);
  });

  test('counts module-shaped lessons in server project metadata', async () => {
    const app = createApp();
    const snapshot = createModuleSnapshot('module-project', 'Corso modulare');

    const saveResponse = await request(app).put('/api/projects/projects/module-project').send({
      snapshot,
    });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body.meta).toMatchObject({
      id: 'module-project',
      title: 'Corso modulare',
      lessonCount: 2,
      completedCount: 1,
      exerciseCount: 1,
      completedExercises: 0,
      coverLabel: '2 lezioni',
    });

    const listResponse = await request(app).get('/api/projects/projects');
    expect(listResponse.body.projects[0]).toMatchObject({
      id: 'module-project',
      lessonCount: 2,
      completedCount: 1,
      exerciseCount: 1,
      completedExercises: 0,
    });
  });

  test('repairs stale server metadata for module-shaped projects while listing', async () => {
    const app = createApp();
    const snapshot = createModuleSnapshot('stale-module-project', 'Corso con meta vecchi');

    await request(app).put('/api/projects/projects/stale-module-project').send({ snapshot });

    const staleMeta = {
      id: 'stale-module-project',
      title: 'Corso con meta vecchi',
      sourceKind: 'document',
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      lastOpenedAt: snapshot.lastOpenedAt,
      lessonCount: 0,
      completedCount: 0,
      exerciseCount: 0,
      completedExercises: 0,
      hasSourceFile: false,
      coverLabel: 'Bozza sincronizzata',
      revision: 1,
    } as const;
    store.replaceProjectMeta('local-user', 'stale-module-project', staleMeta);

    const listResponse = await request(app).get('/api/projects/projects');
    expect(listResponse.body.projects[0]).toMatchObject({
      id: 'stale-module-project',
      lessonCount: 2,
      completedCount: 1,
      exerciseCount: 1,
      completedExercises: 0,
      coverLabel: '2 lezioni',
    });
  });

  test('patches generated lesson content inside module-shaped server projects', async () => {
    const app = createApp();
    const snapshot = createModuleSnapshot('patch-module-project', 'Corso patch moduli');

    await request(app).put('/api/projects/projects/patch-module-project').send({ snapshot });

    const patchResponse = await request(app)
      .patch('/api/projects/projects/patch-module-project')
      .send({
        patch: {
          section: {
            sectionId: 'lesson-2',
            content: 'Contenuto generato e salvato',
            contentBlocks: [
              { type: 'markdown', markdown: 'Contenuto generato e salvato' },
              {
                type: 'inline-quiz',
                quiz: {
                  exerciseType: 'classification',
                  question: 'Qual e il protocollo?',
                  options: ['Regole condivise', 'Un browser', 'Un file', 'Un server'],
                  correctIndex: 0,
                },
              },
            ],
            learningAids: [
              {
                id: 'learning-aid-definition-protocollo',
                kind: 'definition',
                title: 'Protocollo',
                content: 'Regole condivise per scambiare messaggi.',
              },
            ],
            instructionPacks: ['code', 'unsupported-pack', 'technical-sources'],
            isCompleted: true,
            lastGenerationRunId: 'lesson-run-2',
          },
        },
      });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.meta).toMatchObject({
      lessonCount: 2,
      completedCount: 2,
    });

    const loadResponse = await request(app).get('/api/projects/projects/patch-module-project');
    expect(loadResponse.body.project.learningPlan.modules[1].children[0]).toMatchObject({
      id: 'lesson-2',
      content: 'Contenuto generato e salvato',
      contentBlocks: [
        { type: 'markdown', markdown: 'Contenuto generato e salvato' },
        expect.objectContaining({ type: 'inline-quiz' }),
      ],
      learningAids: [
        {
          id: 'learning-aid-definition-protocollo',
          kind: 'definition',
          title: 'Protocollo',
          content: 'Regole condivise per scambiare messaggi.',
        },
      ],
      instructionPacks: ['code', 'technical-sources'],
      isCompleted: true,
      lastGenerationRunId: 'lesson-run-2',
    });
    expect(loadResponse.body.project.learningPlan.modules[0].children[1]).toMatchObject({
      id: 'exercise-1',
      kind: 'exercise',
    });

    const clearResponse = await request(app)
      .patch('/api/projects/projects/patch-module-project')
      .send({
        patch: {
          section: {
            sectionId: 'lesson-2',
            content: null,
            contentBlocks: null,
            generationWarnings: null,
            generatedVisuals: null,
            imageRefs: null,
            learningAids: null,
            lastGenerationRunId: null,
            quiz: null,
            visualPlanningDecision: null,
          },
        },
      });

    expect(clearResponse.status).toBe(200);
    const clearedProject = await request(app).get('/api/projects/projects/patch-module-project');
    expect(clearedProject.body.project.learningPlan.modules[1].children[0]).toMatchObject({
      content: null,
      contentBlocks: null,
      generationWarnings: null,
      generatedVisuals: null,
      imageRefs: null,
      learningAids: null,
      lastGenerationRunId: null,
      quiz: null,
      visualPlanningDecision: null,
    });
  });

  test('rejects source changes through the generic project patch route', async () => {
    const app = createApp();
    const snapshot = createPdfSnapshot('source-patch-project', 'Corso PDF');
    const saveResponse = await request(app)
      .put('/api/projects/projects/source-patch-project')
      .send({ snapshot });

    const patchResponse = await request(app)
      .patch('/api/projects/projects/source-patch-project')
      .send({
        expectedRevision: saveResponse.body.meta.revision,
        patch: { source: null, title: 'Titolo aggiornato' },
      });

    expect(patchResponse.status).toBe(400);
    const loadResponse = await request(app).get('/api/projects/projects/source-patch-project');
    expect(loadResponse.body.project.source).toMatchObject({
      kind: 'pdf',
      ref: { name: 'source.pdf' },
    });
  });

  test('preserves a stored source when a full project update omits it', async () => {
    const app = createApp();
    const snapshot = createPdfSnapshot('source-put-project', 'Corso PDF');
    const saveResponse = await request(app)
      .put('/api/projects/projects/source-put-project')
      .send({ snapshot });

    const updateResponse = await request(app)
      .put('/api/projects/projects/source-put-project')
      .send({
        expectedRevision: saveResponse.body.meta.revision,
        snapshot: {
          ...snapshot,
          title: 'Titolo aggiornato',
          source: null,
          updatedAt: '2026-04-26T11:00:00.000Z',
        },
      });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.snapshot).toMatchObject({
      title: 'Titolo aggiornato',
      source: { kind: 'pdf', ref: { name: 'source.pdf' } },
    });
    const sourceResponse = await request(app).get(
      '/api/projects/projects/source-put-project/source'
    );
    expect(sourceResponse.body.source.data).toBe(snapshot.source?.file.data);
  });

  test('rejects a new detached PDF snapshot without stored source bytes', async () => {
    const app = createApp();
    const snapshot = createPdfSnapshot('missing-source-project', 'Corso PDF');
    const detachedSnapshot = {
      ...snapshot,
      source: {
        ...snapshot.source,
        file: { ...snapshot.source?.file, data: '' },
        ref: {
          byteSize: 20,
          hash: 'a'.repeat(64),
          id: 'source-missing',
          mimeType: 'application/pdf',
          name: 'source.pdf',
          objectPath: 'users/local-user/projects/missing/source-missing/original',
        },
      },
    };

    const response = await request(app)
      .put('/api/projects/projects/missing-source-project')
      .send({ snapshot: detachedSnapshot });

    expect(response.status).toBe(400);
    expect(await store.loadProject('local-user', 'missing-source-project')).toBeNull();
  });

  test('renames a project without replacing the rest of its learning plan', async () => {
    const app = createApp();
    const snapshot = createModuleSnapshot('rename-project', 'Titolo originale');

    await request(app).put('/api/projects/projects/rename-project').send({ snapshot });

    const patchResponse = await request(app)
      .patch('/api/projects/projects/rename-project')
      .send({ patch: { title: 'Titolo rinominato' } });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.meta).toMatchObject({ title: 'Titolo rinominato' });

    const loadResponse = await request(app).get('/api/projects/projects/rename-project');
    expect(loadResponse.body.project.learningPlan).toMatchObject({
      title: 'Titolo rinominato',
      summary: snapshot.learningPlan.summary,
      modules: snapshot.learningPlan.modules,
    });
    expect(loadResponse.body.project.title).toBe('Titolo rinominato');
  });

  test('renames a project before its learning plan has been generated', async () => {
    const app = createApp();
    const snapshot = {
      ...createSnapshot('rename-draft-project', 'Titolo temporaneo'),
      learningPlan: null,
      userProfile: {
        topic: 'Psicologia cognitiva',
      },
    } satisfies ProjectSnapshot;

    await request(app).put('/api/projects/projects/rename-draft-project').send({ snapshot });

    const patchResponse = await request(app)
      .patch('/api/projects/projects/rename-draft-project')
      .send({ patch: { title: 'Titolo scelto' } });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.meta).toMatchObject({ title: 'Titolo scelto' });

    const loadResponse = await request(app).get('/api/projects/projects/rename-draft-project');
    expect(loadResponse.body.project).toMatchObject({
      title: 'Titolo scelto',
      learningPlan: null,
      userProfile: snapshot.userProfile,
    });
  });

  test('keeps users isolated through the auth user id', async () => {
    const app = createApp();
    await request(app)
      .put('/api/projects/projects/shared-id')
      .send({ snapshot: createSnapshot('shared-id', 'Utente locale') });

    process.env.LOCAL_USER_ID = 'other-user';
    const otherUserResponse = await request(app).get('/api/projects/projects');
    expect(otherUserResponse.body.projects).toEqual([]);
  });

  test('creates folders and moves projects into them', async () => {
    const app = createApp();
    await request(app)
      .put('/api/projects/projects/project-1')
      .send({ snapshot: createSnapshot('project-1', 'Corso') });
    await request(app)
      .put('/api/projects/projects/project-2')
      .send({ snapshot: createSnapshot('project-2', 'Secondo corso') });

    const folderResponse = await request(app).post('/api/projects/folders').send({
      name: 'Studio',
    });
    const folderId = folderResponse.body.folder.id;

    await request(app)
      .post('/api/projects/placements/move')
      .send({ projectIds: ['project-2'], folderId, targetIndex: 0 });

    const moveResponse = await request(app)
      .post('/api/projects/placements/move')
      .send({
        projectIds: ['project-1', 'project-1'],
        folderId,
        targetIndex: 0,
      });

    expect(moveResponse.status).toBe(200);
    expect(moveResponse.body.placements).toEqual([
      expect.objectContaining({
        projectId: 'project-1',
        folderId,
        order: 1024,
      }),
      expect.objectContaining({
        projectId: 'project-1',
        folderId,
        order: 1024,
      }),
    ]);
    const placementsResponse = await request(app).get('/api/projects/placements');
    expect(
      placementsResponse.body.placements
        .filter((placement: { folderId: string | null }) => placement.folderId === folderId)
        .map((placement: { order: number; projectId: string }) => ({
          order: placement.order,
          projectId: placement.projectId,
        }))
    ).toEqual([
      { order: 1024, projectId: 'project-1' },
      { order: 2048, projectId: 'project-2' },
    ]);
  });

  test('reports a stale folder deletion as a conflict', async () => {
    vi.spyOn(store, 'deleteFolder').mockRejectedValueOnce(new LibrarySiblingSetChangedError());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const response = await request(createApp()).delete('/api/projects/folders/stale-folder');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: 'La libreria è stata modificata in un’altra sessione. Riprova.',
        success: false,
      });
      expect(warn).toHaveBeenCalledWith(
        '[Projects] Folder deletion conflicted with a concurrent library update.',
        { error: expect.any(LibrarySiblingSetChangedError) }
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('section PATCH uses the fast path with a heavy documentIndex', async () => {
    const app = createApp();

    // Build a snapshot with a ~3MB documentIndex (simulating a 200-page PDF)
    const heavyDocumentIndex = {
      pages: Array.from({ length: 200 }, (_, pageIndex) => ({
        page: pageIndex + 1,
        text: 'Lorem ipsum dolor sit amet '.repeat(600),
      })),
    };
    const snapshot = {
      ...createSnapshot('heavy-project', 'Heavy'),
      learningPlan: {
        title: 'Heavy',
        sections: [
          { id: 'sec-1', title: 'A', content: 'a', annotations: [], isCompleted: false },
          { id: 'sec-2', title: 'B', content: 'b', annotations: [], isCompleted: false },
        ],
      },
      documentIndex: heavyDocumentIndex,
    } as unknown as ProjectSnapshot;

    await request(app).put('/api/projects/projects/heavy-project').send({ snapshot });
    const fullSaveCountBeforePatch = store.fullSaveCount;

    const patchResponse = await request(app)
      .patch('/api/projects/projects/heavy-project')
      .send({
        patch: {
          section: {
            sectionId: 'sec-1',
            annotations: [{ id: 'ann-1', text: 'note' }],
            visualPlanningDecision: {
              initial: { outcome: 'none', plans: [], rationale: 'Testo sufficiente.' },
              reviewed: { outcome: 'visuals', plans: [], rationale: 'Revisione completata.' },
              reviewedAt: '2026-07-17T12:00:00.000Z',
            },
          },
        },
      });

    expect(patchResponse.status).toBe(200);
    expect(store.fullSaveCount).toBe(fullSaveCountBeforePatch);

    // Reload — documentIndex must survive the PATCH unchanged
    const loadResponse = await request(app).get('/api/projects/projects/heavy-project');
    expect(loadResponse.body.project.documentIndex.pages).toHaveLength(200);
    expect(loadResponse.body.project.learningPlan.sections[0].annotations).toEqual([
      { id: 'ann-1', text: 'note' },
    ]);
    expect(
      loadResponse.body.project.learningPlan.sections[0].visualPlanningDecision.reviewed.outcome
    ).toBe('visuals');
  });

  test('rejects a stale session revision without overwriting the accepted patch', async () => {
    const app = createApp();
    const saveResponse = await request(app)
      .put('/api/projects/projects/shared-project')
      .send({ snapshot: createSnapshot('shared-project', 'Corso condiviso') });
    expect(saveResponse.body.meta.revision).toBe(1);

    const acceptedPatch = await request(app)
      .patch('/api/projects/projects/shared-project')
      .send({
        expectedRevision: 1,
        patch: { activeSectionId: 'session-a' },
      });
    expect(acceptedPatch.status).toBe(200);
    expect(acceptedPatch.body.meta.revision).toBe(2);

    const stalePatch = await request(app)
      .patch('/api/projects/projects/shared-project')
      .send({
        expectedRevision: 1,
        patch: { activeSectionId: 'session-b' },
      });
    expect(stalePatch.status).toBe(409);
    expect(stalePatch.body.code).toBe(PROJECT_API_ERROR_CODE.revisionConflict);

    const loadResponse = await request(app).get('/api/projects/projects/shared-project');
    expect(loadResponse.body.project.activeSectionId).toBe('session-a');
    const listResponse = await request(app).get('/api/projects/projects');
    expect(listResponse.body.projects[0].revision).toBe(2);
  });

  test('rebases stale navigation onto a newly generated lesson without losing either change', async () => {
    const app = createApp();
    const projectId = 'navigation-rebase-project';
    const saveResponse = await request(app)
      .put(`/api/projects/projects/${projectId}`)
      .send({ snapshot: createModuleSnapshot(projectId, 'Corso pianificato') });
    expect(saveResponse.body.meta.revision).toBe(1);

    const generationResponse = await request(app)
      .patch(`/api/projects/projects/${projectId}`)
      .send({
        expectedRevision: 1,
        patch: {
          section: {
            sectionId: 'lesson-2',
            content: '# Lezione B generata',
            lastGenerationRunId: 'lesson-b-run',
          },
        },
      });
    expect(generationResponse.status).toBe(200);
    expect(generationResponse.body.meta.revision).toBe(2);

    const staleNavigationResponse = await request(app)
      .patch(`/api/projects/projects/${projectId}`)
      .send({
        expectedRevision: 1,
        patch: { activeSectionId: 'lesson-1', state: 'READING' },
        rebaseMode: PROJECT_PATCH_REBASE_MODE.navigation,
      });
    expect(staleNavigationResponse.status).toBe(200);
    expect(staleNavigationResponse.body.meta.revision).toBe(3);

    const loadResponse = await request(app).get(`/api/projects/projects/${projectId}`);
    expect(loadResponse.body.project.activeSectionId).toBe('lesson-1');
    expect(loadResponse.body.project.learningPlan.modules[1].children[0]).toMatchObject({
      content: '# Lezione B generata',
      id: 'lesson-2',
      lastGenerationRunId: 'lesson-b-run',
    });
  });

  test('rejects navigation rebase for a broad project patch', async () => {
    const app = createApp();
    const projectId = 'invalid-navigation-rebase';
    await request(app)
      .put(`/api/projects/projects/${projectId}`)
      .send({ snapshot: createModuleSnapshot(projectId, 'Titolo originale') });

    const response = await request(app)
      .patch(`/api/projects/projects/${projectId}`)
      .send({
        expectedRevision: 1,
        patch: { activeSectionId: 'lesson-1', title: 'Titolo concorrente' },
        rebaseMode: PROJECT_PATCH_REBASE_MODE.navigation,
      });

    expect(response.status).toBe(400);
    const loadResponse = await request(app).get(`/api/projects/projects/${projectId}`);
    expect(loadResponse.body.project).toMatchObject({
      activeSectionId: null,
      learningPlan: { title: 'Titolo originale' },
    });
  });

  test('records sanitized library import diagnostics without archive content', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await request(createApp()).post('/api/projects/import-diagnostics').send({
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      code: 'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
      stage: 'project-import',
      fileBytes: 173_398_950,
      projectIndex: 1,
      projectCount: 11,
    });

    expect(response.status).toBe(204);
    expect(warning).toHaveBeenCalledWith('[Projects] Library backup import failed.', {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      code: 'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
      stage: 'project-import',
      userId: 'local-user',
      fileBytes: 173_398_950,
      limitBytes: undefined,
      projectCount: 11,
      projectIndex: 1,
    });
    await expect(store.listProjectImportDiagnostics()).resolves.toMatchObject([
      {
        code: 'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
        correlationId: '550e8400-e29b-41d4-a716-446655440000',
        fileBytes: 173_398_950,
        projectCount: 11,
        projectIndex: 1,
        stage: 'project-import',
        userId: 'local-user',
      },
    ]);
    warning.mockRestore();
  });

  test('restricts persisted import diagnostics to admins', async () => {
    await store.recordProjectImportDiagnostic('user-123', {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      code: 'LIBRARY_ARCHIVE_INVALID',
      stage: 'manifest-read',
    });
    const previousAuthMode = process.env.AUTH_MODE;
    const previousJwtSecret = process.env.SUPABASE_JWT_SECRET;
    const previousSupabaseUrl = process.env.SUPABASE_URL;
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    try {
      const app = createApp();
      const userResponse = await request(app)
        .get('/api/projects/import-diagnostics')
        .set('Authorization', `Bearer ${createSupabaseTestToken({ role: 'user' })}`);
      const adminResponse = await request(app)
        .get('/api/projects/import-diagnostics?correlationId=550e8400-e29b-41d4-a716-446655440000')
        .set('Authorization', `Bearer ${createSupabaseTestToken({ role: 'admin' })}`);

      expect(userResponse.status).toBe(403);
      expect(adminResponse.status).toBe(200);
      expect(adminResponse.body.diagnostics).toMatchObject([
        {
          code: 'LIBRARY_ARCHIVE_INVALID',
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          stage: 'manifest-read',
          userId: 'user-123',
        },
      ]);
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(store, 'listProjectImportDiagnostics').mockRejectedValueOnce(
        new Error('database password leaked')
      );
      const failedAdminResponse = await request(app)
        .get('/api/projects/import-diagnostics')
        .set('Authorization', `Bearer ${createSupabaseTestToken({ role: 'admin' })}`);
      expect(failedAdminResponse.status).toBe(500);
      expect(failedAdminResponse.body.error).toBe('Unable to list import diagnostics.');
      expect(failedAdminResponse.body.error).not.toContain('password');
      errorLog.mockRestore();
    } finally {
      if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousAuthMode;
      if (previousJwtSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
      else process.env.SUPABASE_JWT_SECRET = previousJwtSecret;
      if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = previousSupabaseUrl;
    }
  });

  test('does not expose persistence errors while recording import diagnostics', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(store, 'recordProjectImportDiagnostic').mockRejectedValueOnce(
      new Error('database password leaked')
    );

    const response = await request(createApp()).post('/api/projects/import-diagnostics').send({
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      code: 'LIBRARY_ARCHIVE_INVALID',
      stage: 'manifest-read',
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Unable to record import diagnostic.');
    expect(response.body.error).not.toContain('password');
    errorLog.mockRestore();
  });
});
