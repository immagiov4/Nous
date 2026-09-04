import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PostgresLibraryExportRunStore } from '../../src/projects/libraryExportRunStore.js';

const shouldRun = process.env.RUN_SUPABASE_LOCAL_TESTS === '1';
const databaseUrl =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sql = shouldRun ? postgres(databaseUrl, { max: 2 }) : null;
const userId = randomUUID();

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

    await firstStore.createRun({
      bytesWritten: 0,
      correlationId: randomUUID(),
      expectedProjects: [
        {
          id: projectId,
          path: `projects/${projectId}.zip`,
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
      projectId,
      projectIndex: 0,
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
      expect.objectContaining({ archiveBytes: 321, projectId, projectIndex: 0 }),
    ]);

    await restartedStore.markRunning(runId, 'library-archive');
    await restartedStore.markCompleted(runId, { bytes: 654, sha256: 'b'.repeat(64) });
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

  test('allows a new run after a failed export is cancelled', async () => {
    if (!sql) throw new Error('Library export integration database is required.');
    const store = new PostgresLibraryExportRunStore(databaseUrl, sql);
    const runId = randomUUID();
    await store.createRun({
      bytesWritten: 0,
      correlationId: randomUUID(),
      expectedProjects: [
        { id: 'removed-course', path: 'projects/removed-course.zip', title: 'Rimosso' },
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
