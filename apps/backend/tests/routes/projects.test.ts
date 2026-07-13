import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import { setProjectStoreForTesting } from '../../src/projects/projectStore.js';
import { SqliteProjectStore } from '../../src/projects/sqliteProjectStore.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';

let tempDir = '';
let store: SqliteProjectStore;
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
    tempDir = mkdtempSync(join(tmpdir(), 'nous-projects-'));
    store = new SqliteProjectStore(join(tempDir, 'projects.sqlite'));
    setProjectStoreForTesting(store);
  });

  afterEach(async () => {
    store.close();
    setProjectStoreForTesting(null);
    if (previousLocalUserId === undefined) {
      delete process.env.LOCAL_USER_ID;
    } else {
      process.env.LOCAL_USER_ID = previousLocalUserId;
    }
    // bun:sqlite memory-maps WAL/SHM files; force a GC so Windows releases the locks.
    if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
      Bun.gc(true);
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 9) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
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
      syncState: 'sync-ready',
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

    const database = (store as unknown as { database: import('bun:sqlite').Database }).database;
    const storedRow = database
      .prepare('select snapshot_json from project_snapshots where user_id = ? and id = ?')
      .get('local-user', 'pdf-project') as { snapshot_json: string };
    expect(storedRow.snapshot_json).not.toContain(pdfData);
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
    const database = (store as unknown as { database: import('bun:sqlite').Database }).database;
    database
      .prepare(
        `insert into project_snapshots
           (user_id, id, snapshot_json, updated_at, server_updated_at)
         values (?, ?, ?, ?, ?)`
      )
      .run(
        'local-user',
        snapshot.id,
        JSON.stringify(snapshot),
        snapshot.updatedAt,
        snapshot.updatedAt
      );

    const firstLoad = await request(app).get('/api/projects/projects/legacy-pdf');
    const secondLoad = await request(app).get('/api/projects/projects/legacy-pdf');

    expect(firstLoad.body.project.source.file.data).toBe('');
    expect(secondLoad.body.project.source.ref).toEqual(firstLoad.body.project.source.ref);
    const sourceCount = database
      .prepare('select count(*) as count from project_sources where project_id = ?')
      .get(snapshot.id) as { count: number };
    expect(sourceCount.count).toBe(1);
    const storedSnapshot = database
      .prepare('select snapshot_json from project_snapshots where id = ?')
      .get(snapshot.id) as { snapshot_json: string };
    expect(storedSnapshot.snapshot_json).not.toContain(pdfData);
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

    const database = (store as unknown as { database: import('bun:sqlite').Database }).database;
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
      syncState: 'sync-ready',
    };
    database
      .prepare('update projects set meta_json = ? where user_id = ? and id = ?')
      .run(JSON.stringify(staleMeta), 'local-user', 'stale-module-project');

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
    const storeInternals = store as unknown as {
      readSnapshot: (userId: string, id: string) => ProjectSnapshot | null;
      saveProject: SqliteProjectStore['saveProject'];
    };
    const readSnapshotSpy = vi.spyOn(storeInternals, 'readSnapshot');
    const saveProjectSpy = vi.spyOn(storeInternals, 'saveProject');

    const patchResponse = await request(app)
      .patch('/api/projects/projects/heavy-project')
      .send({
        patch: {
          section: { sectionId: 'sec-1', annotations: [{ id: 'ann-1', text: 'note' }] },
        },
      });

    expect(patchResponse.status).toBe(200);
    expect(readSnapshotSpy).not.toHaveBeenCalled();
    expect(saveProjectSpy).not.toHaveBeenCalled();
    readSnapshotSpy.mockRestore();
    saveProjectSpy.mockRestore();

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

  test.skip('migrates inline documentIndex from snapshot_json into its own column', async () => {
    // Pre-create a row with the OLD schema shape: documentIndex inline in snapshot_json.
    const inlineSnapshot = {
      ...createSnapshot('legacy-project', 'Legacy'),
      documentIndex: { pages: [{ page: 1, text: 'inline' }] },
    } as unknown as ProjectSnapshot;

    // Simulate the legacy state: write snapshot WITH documentIndex into snapshot_json
    // and leave document_index_json NULL.
    const legacyDb = (store as unknown as { database: import('bun:sqlite').Database }).database;
    legacyDb
      .prepare(
        `insert into project_snapshots (user_id, id, snapshot_json, document_index_json, updated_at, server_updated_at)
         values (?, ?, ?, NULL, ?, ?)`
      )
      .run(
        'local-user',
        'legacy-project',
        JSON.stringify(inlineSnapshot),
        inlineSnapshot.updatedAt,
        inlineSnapshot.updatedAt
      );

    // Reopen the store — migrate() runs on construction and should backfill the column.
    store.close();
    const dbPath = legacyDb.name;
    store = new SqliteProjectStore(dbPath);
    setProjectStoreForTesting(store);

    // After migration: document_index_json populated, snapshot_json no longer contains the field.
    const row = (store as unknown as { database: import('bun:sqlite').Database }).database
      .prepare(
        `select snapshot_json, document_index_json from project_snapshots where user_id = ? and id = ?`
      )
      .get('local-user', 'legacy-project') as {
      snapshot_json: string;
      document_index_json: string | null;
    };

    expect(row.document_index_json).toBeTruthy();
    expect(JSON.parse(row.snapshot_json).documentIndex).toBeUndefined();

    // Read path must transparently merge the two columns.
    const app = createApp();
    const loadResponse = await request(app).get('/api/projects/projects/legacy-project');
    expect(loadResponse.body.project.documentIndex.pages[0].text).toBe('inline');
  });
});
