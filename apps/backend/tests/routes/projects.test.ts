import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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
    laboratory: null,
    source: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    activeLaboratoryExerciseId: null,
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
    tempDir = mkdtempSync(join(tmpdir(), 'lumina-projects-'));
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
    const snapshot = createSnapshot('project-1', 'Corso LAN');

    const saveResponse = await request(app).put('/api/projects/projects/project-1').send({
      snapshot,
    });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body.meta).toMatchObject({
      id: 'project-1',
      title: 'Corso LAN',
      lessonCount: 2,
      completedCount: 1,
      syncState: 'sync-ready',
    });

    const listResponse = await request(app).get('/api/projects/projects');
    expect(listResponse.body.projects).toHaveLength(1);

    const loadResponse = await request(app).get('/api/projects/projects/project-1');
    expect(loadResponse.body.project).toMatchObject({
      id: 'project-1',
      learningPlan: { title: 'Corso LAN' },
    });

    const exportResponse = await request(app).post('/api/projects/projects/project-1/export');
    expect(exportResponse.body.data).toMatchObject({ id: 'project-1' });

    const touchResponse = await request(app).post('/api/projects/projects/project-1/touch');
    expect(touchResponse.status).toBe(200);

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

  test('counts module-shaped lessons in LAN project metadata', async () => {
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

  test('repairs stale LAN metadata for module-shaped projects while listing', async () => {
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

  test('patches generated lesson content inside module-shaped LAN projects', async () => {
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

  test('section PATCH stays fast even with a heavy documentIndex', async () => {
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

    // Section PATCH should not touch documentIndex — measure round-trip wall time
    const start = Date.now();
    const patchResponse = await request(app)
      .patch('/api/projects/projects/heavy-project')
      .send({
        patch: {
          section: { sectionId: 'sec-1', annotations: [{ id: 'ann-1', text: 'note' }] },
        },
      });
    const elapsed = Date.now() - start;

    expect(patchResponse.status).toBe(200);
    // With documentIndex split into its own column, this should be <100ms even
    // for a 3MB documentIndex. Generous threshold to avoid CI flakes.
    expect(elapsed).toBeLessThan(500);

    // Reload — documentIndex must survive the PATCH unchanged
    const loadResponse = await request(app).get('/api/projects/projects/heavy-project');
    expect(loadResponse.body.project.documentIndex.pages).toHaveLength(200);
    expect(loadResponse.body.project.learningPlan.sections[0].annotations).toEqual([
      { id: 'ann-1', text: 'note' },
    ]);
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
