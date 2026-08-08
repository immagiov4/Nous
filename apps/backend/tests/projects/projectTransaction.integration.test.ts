import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { patchProjectInTransaction } from '../../src/projects/projectTransaction.js';
import type { ProjectSnapshot, SavedProjectMeta } from '../../src/projects/types.js';

const runWorkflowContract = process.env.RUN_WORKFLOW_INTEGRATION_TESTS === '1';
const shouldRun = process.env.RUN_SUPABASE_LOCAL_TESTS === '1' || runWorkflowContract;
const workflowDatabaseUrl = process.env.WORKFLOW_INTEGRATION_DATABASE_URL;
let databaseUrl =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
if (runWorkflowContract) {
  if (!workflowDatabaseUrl) {
    throw new Error(
      'WORKFLOW_INTEGRATION_DATABASE_URL is required for workflow integration tests.'
    );
  }
  databaseUrl = workflowDatabaseUrl;
}

const sql = shouldRun ? postgres(databaseUrl, { max: 3 }) : null;
const userId = randomUUID();
const projectId = `workflow-project-${randomUUID()}`;
const createdAt = '2026-07-01T08:00:00.000Z';

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>(release => {
    resolve = release;
  });
  return { promise, resolve };
};

const projectMeta: SavedProjectMeta = {
  id: projectId,
  title: 'Titolo precedente',
  sourceKind: 'document',
  createdAt,
  updatedAt: createdAt,
  lastOpenedAt: createdAt,
  lessonCount: 1,
  completedCount: 0,
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: '1 lezioni',
  isFavorite: true,
};

const projectSnapshot: ProjectSnapshot = {
  id: projectId,
  version: '4.1',
  title: 'Titolo precedente',
  sourceKind: 'document',
  source: { kind: 'document' },
  learningPlan: {
    title: 'Titolo precedente',
    sections: [{ content: 'Contenuto precedente', id: 'section-1' }],
  },
  createdAt,
  updatedAt: createdAt,
  lastOpenedAt: createdAt,
};

describe.skipIf(!shouldRun)('transactional project patch integration', () => {
  beforeAll(async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await sql`
      insert into auth.users (id, aud, role, created_at, updated_at)
      values (${userId}, 'authenticated', 'authenticated', now(), now())
    `;
    await sql`
      insert into public.projects
        (user_id, id, meta, updated_at, last_opened_at, revision)
      values
        (${userId}, ${projectId}, ${sql.json(projectMeta)}, ${createdAt}, ${createdAt}, 1)
    `;
    await sql`
      insert into public.project_snapshots
        (user_id, id, snapshot, document_index, updated_at)
      values
        (
          ${userId},
          ${projectId},
          ${sql.json(projectSnapshot)},
          ${sql.json({ pages: [{ pageNumber: 1 }] })},
          ${createdAt}
        )
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from auth.users where id = ${userId}`;
    await sql.end();
  });

  test('commits the project patch and revision in the caller transaction', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const updatedAt = '2026-07-29T12:00:00.000Z';

    const result = await sql.begin(transaction =>
      patchProjectInTransaction(transaction, {
        buildPatch: ({ revision, snapshot }) => {
          expect(revision).toBe(1);
          expect(snapshot.documentIndex).toEqual({ pages: [{ pageNumber: 1 }] });
          return { title: 'Titolo aggiornato' };
        },
        projectId,
        updatedAt,
        userId,
      })
    );

    expect(result.meta).toMatchObject({
      isFavorite: true,
      revision: 2,
      title: 'Titolo aggiornato',
      updatedAt,
    });
    const rows = await sql<
      Array<{
        document_index: unknown;
        meta: SavedProjectMeta;
        revision: string;
        snapshot: unknown;
      }>
    >`
      select project.meta, project.revision, snapshot.snapshot, snapshot.document_index
      from public.projects project
      join public.project_snapshots snapshot
        on snapshot.user_id = project.user_id and snapshot.id = project.id
      where project.user_id = ${userId} and project.id = ${projectId}
    `;
    expect(Number(rows[0]?.revision)).toBe(2);
    expect(rows[0]?.meta).toMatchObject({ isFavorite: true, title: 'Titolo aggiornato' });
    expect(rows[0]?.snapshot).toMatchObject({ title: 'Titolo aggiornato', updatedAt });
    expect(rows[0]?.document_index).toEqual({ pages: [{ pageNumber: 1 }] });
  });

  test('rolls back every write when locked-snapshot validation fails', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const validationFailure = new Error('stale lesson result');

    await expect(
      sql.begin(transaction =>
        patchProjectInTransaction(transaction, {
          buildPatch: () => {
            throw validationFailure;
          },
          projectId,
          updatedAt: '2026-07-29T13:00:00.000Z',
          userId,
        })
      )
    ).rejects.toBe(validationFailure);
    const rows = await sql<Array<{ revision: string; title: string }>>`
      select revision, meta ->> 'title' as title
      from public.projects
      where user_id = ${userId} and id = ${projectId}
    `;
    expect(rows[0]).toEqual({ revision: '2', title: 'Titolo aggiornato' });
  });

  test('releases workflow locks instead of deadlocking with project deletion cascade', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const lockOrderProjectId = `workflow-lock-order-${randomUUID()}`;
    const runId = randomUUID();
    const nodeInstanceId = 'lock-order-step';
    const lockOrderMeta = { ...projectMeta, id: lockOrderProjectId };
    const lockOrderSnapshot = { ...projectSnapshot, id: lockOrderProjectId };
    await sql`
      insert into public.projects
        (user_id, id, meta, updated_at, last_opened_at, revision)
      values
        (
          ${userId},
          ${lockOrderProjectId},
          ${sql.json(lockOrderMeta)},
          ${createdAt},
          ${createdAt},
          1
        )
    `;
    await sql`
      insert into public.project_snapshots
        (user_id, id, snapshot, updated_at)
      values
        (${userId}, ${lockOrderProjectId}, ${sql.json(lockOrderSnapshot)}, ${createdAt})
    `;
    await sql`
      insert into public.workflow_runs
        (
          id,
          user_id,
          project_id,
          workflow_id,
          definition_hash,
          definition_hash_version,
          request_key,
          input,
          resolved_config,
          step_policies
        )
      values
        (
          ${runId},
          ${userId},
          ${lockOrderProjectId},
          'lock-order-workflow',
          ${'0'.repeat(64)},
          1,
          ${`lock-order-${runId}`},
          ${sql.json({})},
          ${sql.json({})},
          ${sql.json({})}
        )
    `;
    await sql`
      insert into public.workflow_node_runs
        (run_id, node_instance_id, node_definition_id, kind, input, max_attempts, timeout_ms)
      values
        (${runId}, ${nodeInstanceId}, 'lock-order-step', 'step', ${sql.json({})}, 1, 1)
    `;

    const workflowRowsLocked = createDeferred();
    const projectRowLocked = createDeferred();
    const attemptProjectPatch = createDeferred();
    const checkpointTransaction = sql.begin(async transaction => {
      await transaction`
        select node_instance_id
        from public.workflow_node_runs
        where run_id = ${runId} and node_instance_id = ${nodeInstanceId}
        for update
      `;
      await transaction`
        select id
        from public.workflow_runs
        where id = ${runId}
        for update
      `;
      workflowRowsLocked.resolve();
      await attemptProjectPatch.promise;
      return patchProjectInTransaction(transaction, {
        buildPatch: () => ({ title: 'Titolo durante checkpoint' }),
        projectId: lockOrderProjectId,
        updatedAt: '2026-07-29T15:00:00.000Z',
        userId,
      });
    });
    const checkpointError = checkpointTransaction.then(
      () => undefined,
      error => error as unknown
    );

    await workflowRowsLocked.promise;
    const deleteTransaction = sql.begin(async transaction => {
      await transaction`
        select id
        from public.projects
        where user_id = ${userId} and id = ${lockOrderProjectId}
        for update
      `;
      projectRowLocked.resolve();
      await transaction`
        delete from public.projects
        where user_id = ${userId} and id = ${lockOrderProjectId}
      `;
    });
    const deleteError = deleteTransaction.then(
      () => undefined,
      error => error as unknown
    );

    await projectRowLocked.promise;
    attemptProjectPatch.resolve();

    expect(await checkpointError).toMatchObject({ code: '55P03' });
    expect(await deleteError).toBeUndefined();
    expect(
      await sql`
        select id
        from public.projects
        where user_id = ${userId} and id = ${lockOrderProjectId}
      `
    ).toHaveLength(0);
  });
});
