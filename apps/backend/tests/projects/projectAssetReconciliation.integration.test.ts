import { randomUUID } from 'node:crypto';

import type { ProjectAssetRef } from '@shared/projectAsset';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PostgresProjectAssetStore } from '../../src/projects/postgresProjectAssetStore.js';
import {
  type ProjectAssetObjectStorage,
  ProjectAssetStoreError,
} from '../../src/projects/projectAsset.js';
import { patchProjectInTransaction } from '../../src/projects/projectTransaction.js';
import type { ProjectSnapshot, SavedProjectMeta } from '../../src/projects/types.js';

const shouldRun =
  process.env.RUN_SUPABASE_LOCAL_TESTS === '1' ||
  process.env.RUN_PROJECT_ASSET_INTEGRATION_TESTS === '1';
const databaseUrl =
  process.env.PROJECT_ASSET_INTEGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sql = shouldRun ? postgres(databaseUrl, { max: 2 }) : null;

const userId = randomUUID();
const projectId = `asset-reconciliation-${randomUUID()}`;
const runId = randomUUID();
const nodeInstanceId = 'root/render-assets';
const createdAt = '2026-07-29T08:00:00.000Z';

const projectMeta: SavedProjectMeta = {
  completedCount: 0,
  completedExercises: 0,
  coverLabel: '1 lezioni',
  createdAt,
  exerciseCount: 0,
  hasSourceFile: false,
  id: projectId,
  lastOpenedAt: createdAt,
  lessonCount: 1,
  sourceKind: 'document',
  title: 'Asset reconciliation',
  updatedAt: createdAt,
};

const projectSnapshot: ProjectSnapshot = {
  createdAt,
  id: projectId,
  lastOpenedAt: createdAt,
  learningPlan: {
    sections: [{ generatedVisuals: [], id: 'section-1', title: 'Section' }],
    title: 'Asset reconciliation',
  },
  sourceKind: 'document',
  updatedAt: createdAt,
  version: '4.1',
};

const createMemoryStorage = (): ProjectAssetObjectStorage => {
  const objects = new Map<string, Uint8Array>();
  return {
    delete: vi.fn(async path => {
      objects.delete(path);
    }),
    download: vi.fn(async path => {
      const bytes = objects.get(path);
      if (!bytes) throw new Error('Missing test asset.');
      return bytes;
    }),
    upload: vi.fn(async (path, bytes) => {
      objects.set(path, bytes);
    }),
  };
};

const visual = (asset: ProjectAssetRef, slotId: string) => ({
  createdAt,
  id: `visual-${slotId}`,
  render: { asset, kind: 'image' as const },
  slotId,
});

describe.skipIf(!shouldRun)('project asset reconciliation integration', () => {
  beforeAll(async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
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
      insert into public.project_snapshots (user_id, id, snapshot, updated_at)
      values (${userId}, ${projectId}, ${sql.json(projectSnapshot)}, ${createdAt})
    `;
    await sql`
      insert into public.workflow_runs (
        id, user_id, project_id, workflow_id, definition_hash, definition_hash_version,
        request_key, status, input, resolved_config, step_policies
      ) values (
        ${runId}, ${userId}, ${projectId}, 'asset-reconciliation-test', ${'a'.repeat(64)}, 1,
        ${randomUUID()}, 'running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
      )
    `;
    await sql`
      insert into public.workflow_node_runs (
        run_id, node_instance_id, node_definition_id, kind, status, input, output,
        max_attempts, timeout_ms, has_undo, worker_id, lease_expires_at, fencing_token,
        attempt_count
      ) values (
        ${runId}, ${nodeInstanceId}, 'render-assets', 'step', 'running', '{}'::jsonb, null,
        1, 60000, false, 'test-worker', now() + interval '1 minute', 1, 1
      )
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.project_assets where user_id = ${userId}`;
    await sql`delete from auth.users where id = ${userId}`;
    await sql.end();
  });

  test('queues unreachable assets and rolls back a forged reference with the snapshot', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const assetStore = new PostgresProjectAssetStore(sql, createMemoryStorage());
    const common = {
      mediaType: 'image/png',
      nodeInstanceId,
      projectId,
      runId,
      signal: new AbortController().signal,
      userId,
    };
    const first = await assetStore.stage({
      ...common,
      bytes: new TextEncoder().encode('first'),
      idempotencyKey: 'first',
    });
    const second = await assetStore.stage({
      ...common,
      bytes: new TextEncoder().encode('second'),
      idempotencyKey: 'second',
    });
    const third = await assetStore.stage({
      ...common,
      bytes: new TextEncoder().encode('third'),
      idempotencyKey: 'third',
    });
    const unreferencedDraft = await assetStore.stage({
      ...common,
      bytes: new TextEncoder().encode('unreferenced draft'),
      idempotencyKey: 'unreferenced-draft',
    });
    await sql.begin(transaction =>
      assetStore.adoptNodeAssets(transaction, {
        assetIds: [first.id, second.id, third.id, unreferencedDraft.id],
        nodeInstanceId,
        projectId,
        runId,
        userId,
      })
    );

    await sql.begin(transaction =>
      patchProjectInTransaction(transaction, {
        buildPatch: () => ({
          section: {
            generatedVisuals: [
              visual(first, 'first'),
              visual(second, 'second'),
              visual(third, 'third'),
            ],
            sectionId: 'section-1',
          },
        }),
        projectId,
        updatedAt: '2026-07-29T09:00:00.000Z',
        userId,
      })
    );
    await sql.begin(transaction =>
      patchProjectInTransaction(transaction, {
        buildPatch: () => ({
          section: {
            generatedVisuals: [visual(second, 'second'), visual(third, 'third')],
            sectionId: 'section-1',
          },
        }),
        projectId,
        updatedAt: '2026-07-29T10:00:00.000Z',
        userId,
      })
    );

    const statesBeforeFailure = await sql<Array<{ id: string; state: string }>>`
      select id, state
      from public.project_assets
      where project_id = ${projectId}
      order by id
    `;
    expect(statesBeforeFailure).toEqual(
      [
        { id: first.id, state: 'deletion-pending' },
        { id: second.id, state: 'active' },
        { id: third.id, state: 'active' },
        { id: unreferencedDraft.id, state: 'active' },
      ].sort((left, right) => left.id.localeCompare(right.id))
    );
    const forgedSecond = { ...second, hash: 'f'.repeat(64) };

    await expect(
      sql.begin(transaction =>
        patchProjectInTransaction(transaction, {
          buildPatch: () => ({
            section: {
              generatedVisuals: [visual(forgedSecond, 'second'), visual(third, 'third')],
              sectionId: 'section-1',
            },
          }),
          projectId,
          updatedAt: '2026-07-29T11:00:00.000Z',
          userId,
        })
      )
    ).rejects.toEqual(new ProjectAssetStoreError('asset-not-adoptable'));

    const persisted = await sql<Array<{ revision: number | string; snapshot: ProjectSnapshot }>>`
      select project.revision, project_snapshot.snapshot
      from public.projects project
      join public.project_snapshots project_snapshot
        on project_snapshot.user_id = project.user_id and project_snapshot.id = project.id
      where project.user_id = ${userId} and project.id = ${projectId}
    `;
    expect(Number(persisted[0]?.revision)).toBe(3);
    expect(persisted[0]?.snapshot.learningPlan?.sections?.[0]?.generatedVisuals).toEqual([
      visual(second, 'second'),
      visual(third, 'third'),
    ]);
    expect(
      await sql<Array<{ id: string; state: string }>>`
        select id, state
        from public.project_assets
        where project_id = ${projectId}
        order by id
      `
    ).toEqual(statesBeforeFailure);
  });
});
