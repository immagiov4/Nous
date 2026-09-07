import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { PostgresLibraryExportRunStore } from '../../src/projects/libraryExportRunStore.js';
import { PostgresProjectStore } from '../../src/projects/postgresProjectStore.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';

const shouldRun = process.env.RUN_SUPABASE_LOCAL_TESTS === '1';
const databaseUrl =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sql = shouldRun ? postgres(databaseUrl, { max: 2 }) : null;
const userId = randomUUID();

const createSnapshot = (id: string, updatedAt: string): ProjectSnapshot => ({
  activeSectionId: null,
  createdAt: '2026-09-04T00:00:00.000Z',
  id,
  isLearnMode: false,
  lastOpenedAt: updatedAt,
  learningPlan: { sections: [], title: `Corso ${id}` },
  source: null,
  sourceKind: 'document',
  state: 'READING',
  syllabus: [],
  updatedAt,
  userProfile: null,
  version: '4.1',
});

describe.skipIf(!shouldRun)('PostgresLibraryExportRunStore integration', () => {
  beforeAll(async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    await sql`
      insert into auth.users (id, aud, role, created_at, updated_at)
      values (${userId}, 'authenticated', 'authenticated', now(), now())
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from auth.users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  test('persists checkpoints and the complete export lifecycle across store instances', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const runId = randomUUID();
    const projectId = `library-export-${randomUUID()}`;
    const firstStore = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const projectRows = await sql<Array<{ incarnation_id: string }>>`
      insert into public.projects (user_id, id, meta, updated_at, last_opened_at, revision)
      values (${userId}, ${projectId}, '{}'::jsonb, now(), now(), 7)
      returning incarnation_id
    `;
    const incarnationId = projectRows[0].incarnation_id;

    await firstStore.createRun({
      bytesWritten: 0,
      correlationId: randomUUID(),
      expectedProjects: [
        {
          id: projectId,
          incarnationId,
          path: `projects/${projectId}.zip`,
          revision: 7,
          title: 'Corso persistito',
        },
      ],
      folders: [],
      id: runId,
      phase: 'preparing',
      placements: [{ folderId: null, order: 0, projectId, updatedAt: new Date().toISOString() }],
      status: 'running',
      userId,
    });
    await firstStore.checkpointProject(runId, {
      archiveBytes: 321,
      archivePath: `projects/${projectId}.zip`,
      archiveSha256: 'a'.repeat(64),
      projectIncarnationId: incarnationId,
      projectId,
      projectIndex: 0,
      projectRevision: 7,
    });
    await firstStore.markFailed(runId, {
      code: 'LIBRARY_EXPORT_PROCESS_INTERRUPTED',
      detail: 'The previous process stopped before the export completed.',
      phase: 'project-archive',
    });

    const restartedStore = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const interruptedRun = await restartedStore.findUndeliveredRun(userId);
    expect(interruptedRun).toMatchObject({
      bytesWritten: 321,
      errorCode: 'LIBRARY_EXPORT_PROCESS_INTERRUPTED',
      id: runId,
      phase: 'failed',
      status: 'failed',
    });
    expect(interruptedRun?.checkpoints).toEqual([
      expect.objectContaining({
        archiveBytes: 321,
        projectIncarnationId: incarnationId,
        projectId,
        projectIndex: 0,
        projectRevision: 7,
      }),
    ]);
    await expect(restartedStore.getRunProgress(userId, runId)).resolves.toMatchObject({
      bytesWritten: 321,
      completedProjectCount: 1,
      id: runId,
      projectCount: 1,
      status: 'failed',
    });

    await restartedStore.markRunning(runId, 'integrity-check');
    await expect(
      restartedStore.markCompleted(runId, { bytes: 654, sha256: 'b'.repeat(64) })
    ).resolves.toBe(true);
    expect(await restartedStore.getRun(userId, runId)).toMatchObject({
      archiveBytes: 654,
      archiveSha256: 'b'.repeat(64),
      id: runId,
      phase: 'ready',
      status: 'completed',
    });
    const tokenSha256 = 'c'.repeat(64);
    await expect(restartedStore.authorizeDownload(userId, runId, tokenSha256)).resolves.toBe(true);
    await expect(restartedStore.claimDownload(runId, 'd'.repeat(64))).resolves.toBeNull();
    await expect(restartedStore.claimDownload(runId, tokenSha256)).resolves.toMatchObject({
      id: runId,
      status: 'completed',
      userId,
    });
    await expect(restartedStore.claimDownload(runId, tokenSha256)).resolves.toBeNull();

    await restartedStore.markDownloaded(runId);
    expect(await restartedStore.findUndeliveredRun(userId)).toBeNull();
    expect(await restartedStore.listPendingCleanupRunIds()).toContain(runId);
    await restartedStore.markCleanupCompleted(runId);
    expect(await restartedStore.listPendingCleanupRunIds()).not.toContain(runId);
  });

  test('persists cover revisions and refuses completion after a cover change', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const projectStore = new PostgresProjectStore(databaseUrl, sql);
    const store = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const projectId = `library-export-${randomUUID()}`;
    const runId = randomUUID();
    await projectStore.saveProject(userId, createSnapshot(projectId, '2026-09-04T00:00:00.000Z'));
    const project = await projectStore.loadProjectWithRevision(userId, projectId);
    if (!project) throw new Error('Library export test project was not persisted.');
    await store.createRun({
      bytesWritten: 0,
      correlationId: randomUUID(),
      expectedProjects: [
        {
          id: projectId,
          incarnationId: project.incarnationId,
          path: `projects/${projectId}.zip`,
          revision: project.revision,
          title: 'Corso con copertina',
        },
      ],
      folders: [],
      id: runId,
      phase: 'integrity-check',
      placements: [],
      status: 'running',
      userId,
    });
    const cover = {
      data: Buffer.from('persisted cover').toString('base64'),
      mimeType: 'image/png',
      name: 'cover.png',
    };
    await expect(
      projectStore.saveProjectCover(userId, projectId, cover, {
        expectedRevision: project.revision,
      })
    ).resolves.toMatchObject({ revision: project.revision + 1 });
    await expect(projectStore.loadProjectCover(userId, projectId)).resolves.toEqual(cover);
    await expect(
      projectStore.saveProjectCover(
        userId,
        projectId,
        { ...cover, data: Buffer.from('stale cover').toString('base64') },
        { expectedRevision: project.revision }
      )
    ).resolves.toBeNull();
    await expect(projectStore.loadProjectCover(userId, projectId)).resolves.toEqual(cover);
    await expect(projectStore.loadProjectWithRevision(userId, projectId)).resolves.toMatchObject({
      incarnationId: project.incarnationId,
      revision: project.revision + 1,
    });
    await expect(store.markCompleted(runId, { bytes: 654, sha256: 'b'.repeat(64) })).resolves.toBe(
      false
    );
    await store.markCancelled(runId, {
      code: 'LIBRARY_EXPORT_TEST_COMPLETE',
      detail: 'Cover revision contract verified.',
      phase: 'integrity-check',
    });
  });

  test('waits for an overlapping project save and refuses the stale completion', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const runId = randomUUID();
    const projectId = `library-export-${randomUUID()}`;
    const projectSql = postgres(databaseUrl, { max: 1 });
    const completionSql = postgres(databaseUrl, { max: 1 });
    const blockerSql = postgres(databaseUrl, { max: 1 });
    const projectStore = new PostgresProjectStore(databaseUrl, projectSql);
    const store = new PostgresLibraryExportRunStore(databaseUrl, completionSql);
    const firstUpdatedAt = '2026-09-04T00:00:00.000Z';
    let releaseSnapshotLock = () => {};
    const snapshotLockRelease = new Promise<void>(resolve => {
      releaseSnapshotLock = resolve;
    });
    let reportSnapshotLocked = () => {};
    const snapshotLocked = new Promise<void>(resolve => {
      reportSnapshotLocked = resolve;
    });

    try {
      const completionSessionRows = await completionSql<Array<{ pid: number }>>`
        select pg_backend_pid() as pid
      `;
      const completionSessionPid = completionSessionRows[0].pid;
      const projectSessionRows = await projectSql<Array<{ pid: number }>>`
        select pg_backend_pid() as pid
      `;
      const projectSessionPid = projectSessionRows[0].pid;
      await projectStore.saveProject(userId, createSnapshot(projectId, firstUpdatedAt));
      const project = await projectStore.loadProjectWithRevision(userId, projectId);
      if (!project) throw new Error('Library export test project was not persisted.');
      await store.createRun({
        bytesWritten: 0,
        correlationId: randomUUID(),
        expectedProjects: [
          {
            id: projectId,
            incarnationId: project.incarnationId,
            path: `projects/${projectId}.zip`,
            revision: project.revision,
            title: 'Corso modificato',
          },
        ],
        folders: [],
        id: runId,
        phase: 'integrity-check',
        placements: [{ folderId: null, order: 0, projectId, updatedAt: firstUpdatedAt }],
        status: 'running',
        userId,
      });

      const blocker = blockerSql.begin(async transaction => {
        await transaction`
          select id from public.project_snapshots
          where user_id = ${userId} and id = ${projectId}
          for update
        `;
        reportSnapshotLocked();
        await snapshotLockRelease;
      });
      await snapshotLocked;

      const save = projectStore.saveProject(
        userId,
        createSnapshot(projectId, '2026-09-04T01:00:00.000Z')
      );
      await vi.waitFor(async () => {
        const activityRows = await sql<Array<{ query: string; wait_event_type: string | null }>>`
          select query, wait_event_type
          from pg_stat_activity
          where pid = ${projectSessionPid}
        `;
        expect(activityRows[0]?.wait_event_type).toBe('Lock');
        expect(activityRows[0]?.query).toContain('from public.project_snapshots');
      });
      await expect(
        sql.begin(
          transaction => transaction`
          select id from public.projects
          where user_id = ${userId} and id = ${projectId}
          for share nowait
        `
        )
      ).rejects.toMatchObject({ code: '55P03' });

      const completion = store.markCompleted(runId, {
        bytes: 654,
        sha256: 'b'.repeat(64),
      });
      await vi.waitFor(async () => {
        const activityRows = await sql<Array<{ wait_event_type: string | null }>>`
          select wait_event_type
          from pg_stat_activity
          where pid = ${completionSessionPid}
        `;
        expect(activityRows[0]?.wait_event_type).toBe('Lock');
      });
      releaseSnapshotLock();

      await expect(save).resolves.toMatchObject({ meta: { revision: 2 } });
      await expect(blocker).resolves.toBeUndefined();
      await expect(completion).resolves.toBe(false);
      await expect(store.getRunProgress(userId, runId)).resolves.toMatchObject({
        phase: 'integrity-check',
        status: 'running',
      });
      await store.markCancelled(runId, {
        code: 'LIBRARY_EXPORT_TEST_COMPLETE',
        detail: 'Completion boundary contract verified.',
        phase: 'integrity-check',
      });
    } finally {
      releaseSnapshotLock();
      await Promise.allSettled([projectSql.end({ timeout: 5 }), completionSql.end({ timeout: 5 })]);
      await blockerSql.end({ timeout: 5 });
    }
  });

  test('allows a new run after a failed export is cancelled', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const store = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const runId = randomUUID();
    await store.createRun({
      bytesWritten: 0,
      correlationId: randomUUID(),
      expectedProjects: [
        {
          id: 'removed-course',
          incarnationId: randomUUID(),
          path: 'projects/removed-course.zip',
          revision: 1,
          title: 'Rimosso',
        },
      ],
      folders: [],
      id: runId,
      phase: 'preparing',
      placements: [],
      status: 'running',
      userId,
    });
    await store.markFailed(runId, {
      code: 'LIBRARY_EXPORT_PROJECT_FAILED',
      detail: 'Library export failed.',
      phase: 'project-archive',
    });
    await store.markCancelled(runId, {
      code: 'LIBRARY_EXPORT_EXPECTED_PROJECT_UNAVAILABLE',
      detail: 'An expected project was unavailable when the export resumed.',
      phase: 'project-archive',
    });

    expect(await store.findUndeliveredRun(userId)).toBeNull();
    await expect(
      store.createRun({
        bytesWritten: 0,
        correlationId: randomUUID(),
        expectedProjects: [],
        folders: [],
        id: randomUUID(),
        phase: 'preparing',
        placements: [],
        status: 'running',
        userId,
      })
    ).resolves.toMatchObject({ status: 'running', userId });
  });

  test('deduplicates simultaneous export starts for one user', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    await sql`
      update public.library_export_runs
      set status = 'cancelled', phase = 'failed'
      where user_id = ${userId} and status not in ('cancelled', 'downloaded')
    `;
    const store = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const createInput = (id: string) => ({
      bytesWritten: 0,
      correlationId: randomUUID(),
      expectedProjects: [],
      folders: [],
      id,
      phase: 'preparing' as const,
      placements: [],
      status: 'running' as const,
      userId,
    });
    const firstId = randomUUID();
    const secondId = randomUUID();

    const [first, second] = await Promise.all([
      store.createRun(createInput(firstId)),
      store.createRun(createInput(secondId)),
    ]);

    expect(first.id).toBe(second.id);
    expect([firstId, secondId]).toContain(first.id);
    await store.markCancelled(first.id, {
      code: 'LIBRARY_EXPORT_TEST_COMPLETE',
      detail: 'Concurrent start contract verified.',
      phase: 'preparing',
    });
  });
});
