import { randomUUID } from 'node:crypto';

import { SIBLING_ORDER_STEP } from '@shared/libraryOrdering';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { LibrarySiblingSetChangedError } from '../../src/projects/librarySiblingOrder.js';
import { PostgresProjectStore } from '../../src/projects/postgresProjectStore.js';
import { patchProjectInTransaction } from '../../src/projects/projectTransaction.js';
import type {
  LibraryPlacement,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../src/projects/types.js';

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
const ADVISORY_LOCK_HALF_MASK = 4_294_967_295;

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
  activeSectionId: null,
  id: projectId,
  isLearnMode: false,
  projectFormatVersion: 1,
  version: '4.1',
  title: 'Titolo precedente',
  sourceKind: 'document',
  state: 'READING',
  source: {
    file: { data: 'c291cmNl', mimeType: 'text/plain', name: 'source.txt' },
    kind: 'document',
  },
  learningPlan: {
    title: 'Titolo precedente',
    sections: [{ content: 'Contenuto precedente', id: 'section-1' }],
  },
  syllabus: [],
  userProfile: null,
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

  test('keeps every sibling order complete during concurrent project moves', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const projectIds = [
      `library-order-a-${randomUUID()}`,
      `library-order-b-${randomUUID()}`,
      `library-order-c-${randomUUID()}`,
    ];
    for (const [index, siblingProjectId] of projectIds.entries()) {
      const siblingMeta = {
        ...projectMeta,
        id: siblingProjectId,
        title: `Corso ${index + 1}`,
      };
      const siblingSnapshot = {
        ...projectSnapshot,
        id: siblingProjectId,
        title: siblingMeta.title,
      };
      await sql`
        insert into public.projects
          (user_id, id, meta, updated_at, last_opened_at, revision)
        values
          (${userId}, ${siblingProjectId}, ${sql.json(siblingMeta)}, ${createdAt}, ${createdAt}, 1)
      `;
      await sql`
        insert into public.project_snapshots
          (user_id, id, snapshot, updated_at)
        values
          (${userId}, ${siblingProjectId}, ${sql.json(siblingSnapshot)}, ${createdAt})
      `;
    }
    const store = new PostgresProjectStore(undefined, sql);
    const folder = await store.createFolder(userId, { name: 'Concorrenza' });
    await store.moveProjects(userId, projectIds, folder.id, 0);

    const results = await Promise.allSettled([
      store.moveProjects(userId, [projectIds[0]], folder.id, 3),
      store.moveProjects(userId, [projectIds[2]], folder.id, 0),
    ]);

    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    const rows = await sql<Array<{ order_index: number; placement: { order: number } }>>`
      select order_index, placement
      from public.library_placements
      where user_id = ${userId} and folder_id = ${folder.id} and project_id in ${sql(projectIds)}
      order by order_index, project_id
    `;
    expect(rows).toHaveLength(projectIds.length);
    expect(rows.map(row => row.order_index)).toEqual([
      SIBLING_ORDER_STEP,
      SIBLING_ORDER_STEP * 2,
      SIBLING_ORDER_STEP * 3,
    ]);
    expect(rows.every(row => row.placement.order === row.order_index)).toBe(true);
  });

  test('rejects a move when its observed source parent becomes stale', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const staleProjectId = `library-order-stale-source-${randomUUID()}`;
    const staleMeta = { ...projectMeta, id: staleProjectId, title: 'Sorgente stale' };
    const staleSnapshot = { ...projectSnapshot, id: staleProjectId, title: staleMeta.title };
    await sql`
      insert into public.projects
        (user_id, id, meta, updated_at, last_opened_at, revision)
      values
        (${userId}, ${staleProjectId}, ${sql.json(staleMeta)}, ${createdAt}, ${createdAt}, 1)
    `;
    await sql`
      insert into public.project_snapshots
        (user_id, id, snapshot, updated_at)
      values
        (${userId}, ${staleProjectId}, ${sql.json(staleSnapshot)}, ${createdAt})
    `;

    const store = new PostgresProjectStore(undefined, sql);
    const originalSource = await store.createFolder(userId, { name: 'Sorgente osservata' });
    const destination = await store.createFolder(userId, { name: 'Destinazione stale' });
    const currentSource = await store.createFolder(userId, { name: 'Sorgente corrente' });
    await store.moveProjects(userId, [staleProjectId], originalSource.id, 0);

    const destinationRead = createDeferred();
    const continueStaleMove = createDeferred();
    const delayedSql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const result = sql(strings, ...values);
        const statement = strings.join('?');
        if (
          statement.includes('from public.library_folders') &&
          statement.includes('limit 1') &&
          values.includes(destination.id)
        ) {
          return result.then(async rows => {
            destinationRead.resolve();
            await continueStaleMove.promise;
            return rows;
          });
        }
        return result;
      },
      {
        begin: sql.begin.bind(sql),
        json: sql.json.bind(sql),
      }
    ) as typeof sql;
    const delayedStore = new PostgresProjectStore(undefined, delayedSql);
    const staleMove = delayedStore.moveProjects(userId, [staleProjectId], destination.id, 0);

    await destinationRead.promise;
    try {
      await store.moveProjects(userId, [staleProjectId], currentSource.id, 0);
    } finally {
      continueStaleMove.resolve();
    }

    await expect(staleMove).rejects.toBeInstanceOf(LibrarySiblingSetChangedError);
    const placement = (await store.listPlacements(userId)).find(
      candidate => candidate.projectId === staleProjectId
    );
    expect(placement?.folderId).toBe(currentSource.id);
  });

  test('serializes a project added while its destination siblings are being reordered', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const existingProjectIds = [
      `library-order-blocked-${randomUUID()}`,
      `library-order-existing-${randomUUID()}`,
    ];
    const addedProjectId = `library-order-added-${randomUUID()}`;
    for (const [index, siblingProjectId] of [...existingProjectIds, addedProjectId].entries()) {
      const siblingMeta = {
        ...projectMeta,
        id: siblingProjectId,
        title: `Inserimento concorrente ${index + 1}`,
      };
      const siblingSnapshot = {
        ...projectSnapshot,
        id: siblingProjectId,
        title: siblingMeta.title,
      };
      await sql`
        insert into public.projects
          (user_id, id, meta, updated_at, last_opened_at, revision)
        values
          (${userId}, ${siblingProjectId}, ${sql.json(siblingMeta)}, ${createdAt}, ${createdAt}, 1)
      `;
      await sql`
        insert into public.project_snapshots
          (user_id, id, snapshot, updated_at)
        values
          (${userId}, ${siblingProjectId}, ${sql.json(siblingSnapshot)}, ${createdAt})
      `;
    }

    const store = new PostgresProjectStore(undefined, sql);
    await store.listPlacements(userId);
    const folder = await store.createFolder(userId, { name: 'Inserimento concorrente' });
    await store.moveProjects(userId, existingProjectIds, folder.id, 0);

    const identifierSuffix = randomUUID().replaceAll('-', '_');
    const functionName = `test_block_library_reorder_${identifierSuffix}`;
    const triggerName = `test_block_library_reorder_${identifierSuffix}`;
    const blockerLockKey = 'library-order-concurrent-addition-test';
    const siblingLockKey = JSON.stringify(['library-sibling-order', userId, folder.id]);
    await sql`
      create function ${sql(functionName)}()
      returns trigger
      language plpgsql
      as $function$
      begin
        if new.project_id like 'library-order-blocked-%' then
          perform pg_advisory_xact_lock(
            hashtextextended('library-order-concurrent-addition-test', 0)
          );
        end if;
        return new;
      end;
      $function$
    `;
    await sql`
      create trigger ${sql(triggerName)}
      before update on public.library_placements
      for each row execute function ${sql(functionName)}()
    `;

    const blocker = await sql.reserve();
    let blockerLocked = false;
    let reorderPromise: Promise<LibraryPlacement[]> | undefined;
    let additionPromise: Promise<LibraryPlacement[]> | undefined;
    const readAdvisoryWaiterCount = async (lockKey: string) => {
      const rows = await blocker<Array<{ waiter_count: number | string }>>`
        with target_lock as (
          select hashtextextended(${lockKey}, 0) as lock_id
        )
        select count(*) as waiter_count
        from pg_locks advisory_lock
        cross join target_lock
        where advisory_lock.locktype = 'advisory'
          and advisory_lock.database = (select oid from pg_database where datname = current_database())
          and advisory_lock.classid::bigint = (
            (target_lock.lock_id >> 32) & ${ADVISORY_LOCK_HALF_MASK}::bigint
          )
          and advisory_lock.objid::bigint = (
            target_lock.lock_id & ${ADVISORY_LOCK_HALF_MASK}::bigint
          )
          and advisory_lock.objsubid = 1
          and not advisory_lock.granted
      `;
      return Number(rows[0]?.waiter_count ?? 0);
    };
    const waitForAdvisoryWaiter = async (
      lockKey: string,
      operation: Promise<LibraryPlacement[]>
    ) => {
      let cancelled = false;
      const pollForWaiter = async () => {
        while (!cancelled && (await readAdvisoryWaiterCount(lockKey)) === 0) {
          // Each database query yields to the operation and the suite-level timeout policy.
        }
      };
      const waiter = pollForWaiter();
      try {
        await Promise.race([
          waiter,
          operation.then(
            () => {
              throw new Error('Library operation completed before reaching the expected lock.');
            },
            error => {
              throw error;
            }
          ),
        ]);
      } finally {
        cancelled = true;
        await waiter;
      }
    };

    try {
      await blocker`
        select pg_advisory_lock(hashtextextended(${blockerLockKey}, 0))
      `;
      blockerLocked = true;
      reorderPromise = store.moveProjects(userId, [existingProjectIds[0]], folder.id, 2);
      await waitForAdvisoryWaiter(blockerLockKey, reorderPromise);

      additionPromise = store.moveProjects(userId, [addedProjectId], folder.id, 1);
      await waitForAdvisoryWaiter(siblingLockKey, additionPromise);

      await blocker`
        select pg_advisory_unlock(hashtextextended(${blockerLockKey}, 0))
      `;
      blockerLocked = false;
      await Promise.all([reorderPromise, additionPromise]);
    } finally {
      if (blockerLocked) {
        await blocker`
          select pg_advisory_unlock(hashtextextended(${blockerLockKey}, 0))
        `;
      }
      await Promise.allSettled([reorderPromise, additionPromise].filter(Boolean));
      blocker.release();
      await sql`drop trigger if exists ${sql(triggerName)} on public.library_placements`;
      await sql`drop function if exists ${sql(functionName)}()`;
    }

    const rows = await sql<Array<{ order_index: number; placement: { order: number } }>>`
      select order_index, placement
      from public.library_placements
      where user_id = ${userId}
        and folder_id = ${folder.id}
        and project_id in ${sql([...existingProjectIds, addedProjectId])}
      order by order_index, project_id
    `;
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.order_index)).toEqual([
      SIBLING_ORDER_STEP,
      SIBLING_ORDER_STEP * 2,
      SIBLING_ORDER_STEP * 3,
    ]);
    expect(rows.every(row => row.placement.order === row.order_index)).toBe(true);
  });

  test('rolls back the complete sibling order when one row update fails', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const projectIds = [
      `library-order-safe-${randomUUID()}`,
      `library-order-failure-${randomUUID()}`,
    ];
    for (const [index, siblingProjectId] of projectIds.entries()) {
      const siblingMeta = {
        ...projectMeta,
        id: siblingProjectId,
        title: `Rollback ${index + 1}`,
      };
      const siblingSnapshot = {
        ...projectSnapshot,
        id: siblingProjectId,
        title: siblingMeta.title,
      };
      await sql`
        insert into public.projects
          (user_id, id, meta, updated_at, last_opened_at, revision)
        values
          (${userId}, ${siblingProjectId}, ${sql.json(siblingMeta)}, ${createdAt}, ${createdAt}, 1)
      `;
      await sql`
        insert into public.project_snapshots
          (user_id, id, snapshot, updated_at)
        values
          (${userId}, ${siblingProjectId}, ${sql.json(siblingSnapshot)}, ${createdAt})
      `;
    }

    const store = new PostgresProjectStore(undefined, sql);
    const folder = await store.createFolder(userId, { name: 'Rollback' });
    await store.createFolder(userId, { name: 'Cartella figlia', parentFolderId: folder.id });
    await store.moveProjects(userId, projectIds, folder.id, 0);
    const readSiblingState = () => sql`
      select 'folder' as kind, id, parent_folder_id as parent_id, order_index, folder as value
      from public.library_folders
      where user_id = ${userId} and parent_folder_id = ${folder.id}
      union all
      select 'project' as kind, project_id as id, folder_id as parent_id, order_index, placement as value
      from public.library_placements
      where user_id = ${userId} and folder_id = ${folder.id}
      order by kind, id
    `;
    const stateBeforeFailure = await readSiblingState();
    const identifierSuffix = randomUUID().replaceAll('-', '_');
    const functionName = `test_reject_library_reorder_${identifierSuffix}`;
    const triggerName = `test_reject_library_reorder_${identifierSuffix}`;

    await sql`
      create function ${sql(functionName)}()
      returns trigger
      language plpgsql
      as $function$
      begin
        if new.project_id like 'library-order-failure-%' then
          raise exception 'forced library reorder failure';
        end if;
        return new;
      end;
      $function$
    `;
    await sql`
      create trigger ${sql(triggerName)}
      before update on public.library_placements
      for each row execute function ${sql(functionName)}()
    `;

    try {
      await expect(store.moveProjects(userId, [projectIds[1]], folder.id, 0)).rejects.toThrow(
        'forced library reorder failure'
      );
    } finally {
      await sql`drop trigger if exists ${sql(triggerName)} on public.library_placements`;
      await sql`drop function if exists ${sql(functionName)}()`;
    }

    expect(await readSiblingState()).toEqual(stateBeforeFailure);
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
