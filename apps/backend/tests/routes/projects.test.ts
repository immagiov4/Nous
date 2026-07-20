import JSZip from 'jszip';
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

  test('imports a binary source archive in bounded chunks', async () => {
    const app = createApp();
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
        snapshot,
        sourceFile: { mimeType: 'application/zip', name: 'engine.zip' },
      });
    expect(response.status).toBe(200);
    expect(response.body.snapshot).toMatchObject({ id: 'binary-import-project' });
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
      hash: '',
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
