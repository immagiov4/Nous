import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import { setProjectStoreForTesting } from '../../src/projects/projectStore.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

let store: InMemoryProjectStore;
let previousLocalUserId: string | undefined;

const createSnapshot = (id: string, title: string, updatedAt = '2026-04-26T10:00:00.000Z') =>
  ({
    id,
    version: '4.1',
    sourceKind: 'document',
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

  test('stores raster course covers separately from project snapshots', async () => {
    const app = createApp();
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

  test('migrates a legacy embedded PDF once when the project is first loaded', async () => {
    const app = createApp();
    const pdfData = 'JVBERi0xLjQKbGVnYWN5';
    const snapshot = {
      ...createSnapshot('legacy-pdf', 'Corso legacy'),
      source: {
        kind: 'pdf',
        file: {
          name: 'legacy.pdf',
          mimeType: 'application/pdf',
          data: pdfData,
        },
      },
    } satisfies ProjectSnapshot;
    store.seedStoredSnapshot('local-user', snapshot);

    const firstLoad = await request(app).get('/api/projects/projects/legacy-pdf');
    const secondLoad = await request(app).get('/api/projects/projects/legacy-pdf');

    expect(firstLoad.body.project.source.file.data).toBe('');
    expect(secondLoad.body.project.source.ref).toEqual(firstLoad.body.project.source.ref);
    expect(store.countStoredSources('local-user')).toBe(1);
    expect(JSON.stringify(store.readStoredSnapshot('local-user', snapshot.id))).not.toContain(
      pdfData
    );
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
            learningAids: [
              {
                id: 'learning-aid-definition-protocollo',
                kind: 'definition',
                title: 'Protocollo',
                content: 'Regole condivise per scambiare messaggi.',
              },
            ],
            isCompleted: true,
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
      learningAids: [
        {
          id: 'learning-aid-definition-protocollo',
          kind: 'definition',
          title: 'Protocollo',
          content: 'Regole condivise per scambiare messaggi.',
        },
      ],
      isCompleted: true,
    });
    expect(loadResponse.body.project.learningPlan.modules[0].children[1]).toMatchObject({
      id: 'exercise-1',
      kind: 'exercise',
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

    const folderResponse = await request(app).post('/api/projects/folders').send({
      name: 'Studio',
    });
    const folderId = folderResponse.body.folder.id;

    const moveResponse = await request(app)
      .post('/api/projects/placements/move')
      .send({
        projectIds: ['project-1'],
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
    ]);
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
          section: { sectionId: 'sec-1', annotations: [{ id: 'ann-1', text: 'note' }] },
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

    const loadResponse = await request(app).get('/api/projects/projects/shared-project');
    expect(loadResponse.body.project.activeSectionId).toBe('session-a');
    const listResponse = await request(app).get('/api/projects/projects');
    expect(listResponse.body.projects[0].revision).toBe(2);
  });

  test('records sanitized library import diagnostics without archive content', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await request(createApp()).post('/api/projects/import-diagnostics').send({
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      code: 'LIBRARY_ARCHIVE_PROJECT_INVALID',
      stage: 'nested-project-read',
      fileBytes: 173_398_950,
      projectIndex: 1,
      projectCount: 11,
    });

    expect(response.status).toBe(204);
    expect(warning).toHaveBeenCalledWith('[Projects] Library backup import failed.', {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      code: 'LIBRARY_ARCHIVE_PROJECT_INVALID',
      stage: 'nested-project-read',
      userId: 'local-user',
      fileBytes: 173_398_950,
      limitBytes: undefined,
      projectCount: 11,
      projectIndex: 1,
    });
    warning.mockRestore();
  });
});
