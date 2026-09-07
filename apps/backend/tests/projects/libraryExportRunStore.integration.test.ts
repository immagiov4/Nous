import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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

  test('preserves issued tickets across completion and store restart, consuming each only once', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const store = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const runId = randomUUID();
    const firstToken = '1'.repeat(64);
    const secondToken = '2'.repeat(64);
    const cutoff = new Date(0);
    await store.createRun({
      id: runId,
      userId,
      correlationId: randomUUID(),
      status: 'running',
      phase: 'integrity-check',
      bytesWritten: 0,
      expectedProjects: [],
      folders: [],
      placements: [],
    });
    expect(await store.markCompleted(runId, { bytes: 321, sha256: 'a'.repeat(64) })).toBe(true);
    expect(await store.authorizeDownload(randomUUID(), runId, firstToken, cutoff)).toBe(false);
    expect(await store.authorizeDownload(userId, runId, firstToken, cutoff)).toBe(true);
    expect(await store.authorizeDownload(userId, runId, secondToken, cutoff)).toBe(true);
    const claims = await Promise.all([
      store.claimDownload(runId, firstToken, cutoff),
      store.claimDownload(runId, firstToken, cutoff),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.markDownloaded(runId);
    const restarted = new PostgresLibraryExportRunStore(databaseUrl, sql);
    expect(await restarted.hasUnclaimedDownloadTickets(runId, cutoff)).toBe(true);
    expect(await restarted.authorizeDownload(userId, runId, '3'.repeat(64), cutoff)).toBe(false);
    expect(await restarted.claimDownload(runId, secondToken, cutoff)).toMatchObject({
      id: runId,
      status: 'downloaded',
      userId,
    });
    expect(await restarted.claimDownload(runId, secondToken, cutoff)).toBeNull();
    expect(await restarted.hasUnclaimedDownloadTickets(runId, cutoff)).toBe(false);
    await restarted.markCleanupCompleted(runId);
  });

  test('migrates a legacy outstanding ticket once and keeps ticket storage backend-private', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const store = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const runId = randomUUID();
    const token = '4'.repeat(64);
    await store.createRun({
      id: runId,
      userId,
      correlationId: randomUUID(),
      status: 'running',
      phase: 'integrity-check',
      bytesWritten: 0,
      expectedProjects: [],
      folders: [],
      placements: [],
    });
    await store.markCompleted(runId, { bytes: 321, sha256: 'a'.repeat(64) });
    await sql`update public.library_export_runs set download_token_sha256 = ${token} where id = ${runId}`;
    const migration = await readFile(
      'supabase/migrations/20260907183055_add_library_export_download_tickets.sql',
      'utf8'
    );
    await sql.begin(transaction => transaction.unsafe(migration));
    await sql.begin(transaction => transaction.unsafe(migration));
    expect(await store.claimDownload(runId, token, new Date(0))).toMatchObject({ id: runId });
    await sql.begin(transaction => transaction.unsafe(migration));
    expect(await store.claimDownload(runId, token, new Date(0))).toBeNull();
    const privileges = await sql<
      Array<{
        relrowsecurity: boolean;
        anonymous_read: boolean;
        user_read: boolean;
        user_write: boolean;
        backend_read: boolean;
        backend_insert: boolean;
        backend_delete: boolean;
      }>
    >`
      select relrowsecurity,
        has_table_privilege('anon', oid, 'SELECT') as anonymous_read,
        has_table_privilege('authenticated', oid, 'SELECT') as user_read,
        has_table_privilege('authenticated', oid, 'INSERT,UPDATE,DELETE') as user_write,
        has_table_privilege('service_role', oid, 'SELECT') as backend_read,
        has_table_privilege('service_role', oid, 'INSERT') as backend_insert,
        has_table_privilege('service_role', oid, 'DELETE') as backend_delete
      from pg_class where oid = 'public.library_export_download_tickets'::regclass
    `;
    expect(privileges[0]).toEqual({
      relrowsecurity: true,
      anonymous_read: false,
      user_read: false,
      user_write: false,
      backend_read: true,
      backend_insert: true,
      backend_delete: true,
    });
    await expect(
      sql.begin(async transaction => {
        await transaction`set local role authenticated`;
        await transaction`select * from public.library_export_download_tickets`;
      })
    ).rejects.toMatchObject({ code: '42501' });
    await store.markDownloaded(runId);
    await store.markCleanupCompleted(runId);
  });

  test('revokes failed archive tickets so retries cannot renew their validity', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const store = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const runId = randomUUID();
    const token = '5'.repeat(64);
    await store.createRun({
      id: runId,
      userId,
      correlationId: randomUUID(),
      status: 'running',
      phase: 'integrity-check',
      bytesWritten: 0,
      expectedProjects: [],
      folders: [],
      placements: [],
    });
    await store.markCompleted(runId, { bytes: 321, sha256: 'a'.repeat(64) });
    await store.authorizeDownload(userId, runId, token, new Date(0));
    await store.markFailed(runId, {
      code: 'INTEGRITY_FAILED',
      detail: 'Test corruption.',
      phase: 'integrity-check',
    });
    await store.markRunning(runId, 'integrity-check');
    await store.markCompleted(runId, { bytes: 321, sha256: 'b'.repeat(64) });
    expect(await store.claimDownload(runId, token, new Date(0))).toBeNull();
    expect(await store.hasUnclaimedDownloadTickets(runId, new Date(0))).toBe(false);
    await store.markCancelled(runId, {
      code: 'TEST_COMPLETE',
      detail: 'Test finished.',
      phase: 'ready',
    });
    await store.markCleanupCompleted(runId);
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
    const cutoff = new Date(0);
    await expect(
      restartedStore.authorizeDownload(userId, runId, tokenSha256, cutoff)
    ).resolves.toBe(true);
    await expect(restartedStore.claimDownload(runId, 'd'.repeat(64), cutoff)).resolves.toBeNull();
    await expect(restartedStore.claimDownload(runId, tokenSha256, cutoff)).resolves.toMatchObject({
      id: runId,
      status: 'completed',
      userId,
    });
    await expect(restartedStore.claimDownload(runId, tokenSha256, cutoff)).resolves.toBeNull();

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

  test('refuses stale favorite writes without advancing the project revision', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const projectStore = new PostgresProjectStore(databaseUrl, sql);
    const projectId = `library-export-${randomUUID()}`;
    const saved = await projectStore.saveProject(
      userId,
      createSnapshot(projectId, '2026-09-04T00:00:00.000Z')
    );
    const revision = saved.meta.revision;
    if (revision === undefined) throw new Error('Persisted project revision is required.');
    await projectStore.setProjectFavorite(userId, projectId, true, { expectedRevision: revision });
    await expect(
      projectStore.setProjectFavorite(userId, projectId, false, { expectedRevision: revision })
    ).rejects.toMatchObject({ name: 'ProjectRevisionConflictError' });
    const persisted = await projectStore.loadProjectWithRevision(userId, projectId);
    expect(persisted?.revision).toBe(revision + 1);
    expect(
      (await projectStore.listProjects(userId)).find(project => project.id === projectId)
        ?.isFavorite
    ).toBe(true);
    await expect(
      projectStore.setProjectFavorite(userId, randomUUID(), true, { expectedRevision: revision })
    ).rejects.toMatchObject({ name: 'ProjectNotFoundError' });
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

  test('expires terminal states from their transition time and never resurrects a cancelled run', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const store = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const runId = randomUUID();
    await store.createRun({
      id: runId,
      userId,
      correlationId: randomUUID(),
      status: 'running',
      phase: 'integrity-check',
      bytesWritten: 0,
      expectedProjects: [],
      folders: [],
      placements: [],
    });
    await store.markCompleted(runId, { bytes: 321, sha256: 'a'.repeat(64) });
    const cutoff = new Date('2026-09-07T12:00:00Z');
    const beforeCutoff = new Date(cutoff.getTime() - 1);
    await sql`update public.library_export_runs set completed_at = ${beforeCutoff}, updated_at = clock_timestamp() where id = ${runId}`;
    const token = 'b'.repeat(64);
    await expect(store.authorizeDownload(userId, runId, token, new Date(0))).resolves.toBe(true);
    await store.getRunProgress(userId, runId);
    expect(await store.listExpiredRunIds(cutoff)).toContain(runId);
    await expect(store.authorizeDownload(userId, runId, token, cutoff)).resolves.toBe(false);
    await expect(store.claimDownload(runId, token, cutoff)).resolves.toBeNull();
    await expect(store.cancelExpiredRun(runId, cutoff)).resolves.toBe(true);
    await store.markRunning(runId, 'preparing');
    await store.markFailed(runId, {
      code: 'LATE_FAILURE',
      detail: 'A delayed operation failed.',
      phase: 'integrity-check',
    });
    expect(await store.getRun(userId, runId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'LIBRARY_EXPORT_RETENTION_EXPIRED',
    });
    expect(await store.listPendingCleanupRunIds()).toContain(runId);
    await expect(store.cancelExpiredRun(runId, cutoff)).resolves.toBe(false);

    const failedId = randomUUID();
    await store.createRun({
      id: failedId,
      userId,
      correlationId: randomUUID(),
      status: 'running',
      phase: 'preparing',
      bytesWritten: 0,
      expectedProjects: [],
      folders: [],
      placements: [],
    });
    await store.markFailed(failedId, {
      code: 'EXPORT_FAILED',
      detail: 'Simulated export failure.',
      phase: 'preparing',
    });
    await sql`update public.library_export_runs set updated_at = ${cutoff} where id = ${failedId}`;
    await store.getRunProgress(userId, failedId);
    await store.markFailed(failedId, {
      code: 'DUPLICATE_FAILURE',
      detail: 'Repeated failure callback.',
      phase: 'preparing',
    });
    expect(await store.listExpiredRunIds(cutoff)).toContain(failedId);
    await store.markRunning(failedId, 'preparing');
    expect(await store.cancelExpiredRun(failedId, cutoff)).toBe(false);
    expect(await store.listExpiredRunIds(cutoff)).not.toContain(failedId);
    await store.markCancelled(failedId, {
      code: 'TEST_COMPLETE',
      detail: 'Retention test finished.',
      phase: 'preparing',
    });
  });

  test('rechecks an expired candidate after a concurrent retry commits', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const store = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const runId = randomUUID();
    const cutoff = new Date('2026-09-07T12:00:00Z');
    await store.createRun({
      id: runId,
      userId,
      correlationId: randomUUID(),
      status: 'running',
      phase: 'preparing',
      bytesWritten: 0,
      expectedProjects: [],
      folders: [],
      placements: [],
    });
    await store.markFailed(runId, {
      code: 'EXPORT_FAILED',
      detail: 'Simulated export failure.',
      phase: 'preparing',
    });
    await sql`update public.library_export_runs set updated_at = ${cutoff} where id = ${runId}`;
    expect(await store.listExpiredRunIds(cutoff)).toContain(runId);
    const retrySql = postgres(databaseUrl, { max: 1 });
    const expirySql = postgres(databaseUrl, { max: 1 });
    const expiryStore = new PostgresLibraryExportRunStore(databaseUrl, expirySql);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let retry: Promise<unknown> | undefined;
    try {
      const sessions = await expirySql<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
      retry = retrySql.begin(async transaction => {
        await transaction`update public.library_export_runs set status = 'running', phase = 'preparing', updated_at = clock_timestamp() where id = ${runId}`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const expiry = expiryStore.cancelExpiredRun(runId, cutoff);
      await vi.waitFor(async () => {
        const blocked = await sql<
          Array<{ waiting: boolean }>
        >`select cardinality(pg_blocking_pids(${sessions[0].pid})) > 0 as waiting`;
        expect(blocked[0].waiting).toBe(true);
      });
      release.resolve();
      await retry;
      expect(await expiry).toBe(false);
      expect(await store.getRun(userId, runId)).toMatchObject({ status: 'running' });
    } finally {
      release.resolve();
      await retry;
      await retrySql.end();
      await expirySql.end();
      await store.markCancelled(runId, {
        code: 'TEST_COMPLETE',
        detail: 'Concurrency test finished.',
        phase: 'preparing',
      });
    }
  });
});
