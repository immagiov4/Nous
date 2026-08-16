import { createHash, randomUUID } from 'node:crypto';

import {
  createProjectBackupArchive,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
} from '@shared/projectBackupArchive';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PostgresProjectAssetStore } from '../../src/projects/postgresProjectAssetStore.js';
import { PostgresProjectStore } from '../../src/projects/postgresProjectStore.js';
import {
  buildProjectAssetDescriptor,
  type ProjectAssetObjectStorage,
} from '../../src/projects/projectAsset.js';
import { PostgresProjectAssetDeletionQueue } from '../../src/projects/projectAssetDeletionQueue.js';
import { PostgresProjectAssetImporter } from '../../src/projects/projectAssetImport.js';
import { ProjectSourceStorageError } from '../../src/projects/projectSourceStorage.js';

const shouldRun =
  process.env.RUN_SUPABASE_LOCAL_TESTS === '1' ||
  process.env.RUN_PROJECT_ASSET_INTEGRATION_TESTS === '1';
const databaseUrl =
  process.env.PROJECT_ASSET_INTEGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const sql = shouldRun ? postgres(databaseUrl, { max: 4 }) : null;
const userId = randomUUID();
const projectId = `project-assets-${randomUUID()}`;
const nodeInstanceId = 'root/render-visual';
const testSignal = new AbortController().signal;

const createWorkflowRun = async (workflowProjectId = projectId): Promise<string> => {
  if (!sql) throw new Error('Project asset integration database is required.');
  const runId = randomUUID();
  await sql`
    insert into public.workflow_runs (
      id, user_id, project_id, workflow_id, definition_hash, definition_hash_version,
      request_key, status, input, resolved_config, step_policies
    ) values (
      ${runId}, ${userId}, ${workflowProjectId}, 'visual-test', ${'a'.repeat(64)}, 1,
      ${randomUUID()}, 'running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
    )
  `;
  await sql`
    insert into public.workflow_node_runs (
      run_id, node_instance_id, node_definition_id, kind, status, input, output,
      max_attempts, timeout_ms, has_undo, worker_id, lease_expires_at, fencing_token,
      attempt_count
    ) values (
      ${runId}, ${nodeInstanceId}, 'render-visual', 'step', 'running', '{}'::jsonb, null,
      3, 60000, false, 'test-worker', now() + interval '1 minute', 1, 1
    )
  `;
  return runId;
};

const createMemoryStorage = (): ProjectAssetObjectStorage & {
  objects: Map<string, Uint8Array>;
} => {
  const objects = new Map<string, Uint8Array>();
  return {
    delete: vi.fn(async path => {
      if (!objects.delete(path)) throw new ProjectSourceStorageError('delete-failed', 404);
    }),
    download: vi.fn(async (path, expected) => {
      const bytes = objects.get(path);
      if (!bytes || bytes.byteLength !== expected.byteSize) {
        throw new ProjectSourceStorageError('integrity-mismatch');
      }
      return bytes;
    }),
    objects,
    upload: vi.fn(async (path, bytes) => {
      if (objects.has(path)) throw new ProjectSourceStorageError('upload-failed', 409);
      objects.set(path, bytes);
    }),
  };
};

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>(release => {
    resolve = release;
  });
  return { promise, resolve };
};

describe.skipIf(!shouldRun || !databaseUrl)('PostgresProjectAssetStore integration', () => {
  beforeAll(async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    await sql`
      insert into auth.users (id, aud, role, created_at, updated_at)
      values (${userId}, 'authenticated', 'authenticated', now(), now())
    `;
    await sql`
      insert into public.projects (user_id, id, meta, updated_at, last_opened_at)
      values (${userId}, ${projectId}, '{}'::jsonb, now(), now())
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.project_assets where user_id = ${userId}`;
    await sql`
      delete from public.project_asset_deletions
      where object_path like ${`users/${userId}/%`}
         or object_path like ${`integration-claim/${userId}/%`}
    `;
    await sql`delete from auth.users where id = ${userId}`;
    await sql.end();
  });

  test('stages idempotently, adopts selected refs, and cleans only the unadopted asset', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const runId = await createWorkflowRun();
    const storage = createMemoryStorage();
    const store = new PostgresProjectAssetStore(sql, storage);
    const baseInput = {
      mediaType: 'image/png',
      nodeInstanceId,
      projectId,
      runId,
      signal: testSignal,
      userId,
    };
    const adopted = await store.stage({
      ...baseInput,
      bytes: new TextEncoder().encode('adopted'),
      idempotencyKey: 'adopted',
    });
    const duplicate = await store.stage({
      ...baseInput,
      bytes: new TextEncoder().encode('adopted'),
      idempotencyKey: 'adopted',
    });
    const unadopted = await store.stage({
      ...baseInput,
      bytes: new TextEncoder().encode('unadopted'),
      idempotencyKey: 'unadopted',
    });

    expect(duplicate).toEqual(adopted);
    expect(storage.download).toHaveBeenCalledOnce();
    const refs = await sql.begin(transaction =>
      store.adoptNodeAssets(transaction, {
        assetIds: [adopted.id],
        nodeInstanceId,
        projectId,
        runId,
        userId,
      })
    );
    expect(refs).toEqual([adopted]);
    await expect(store.readActive({ assetId: adopted.id, projectId, userId })).resolves.toEqual({
      bytes: new TextEncoder().encode('adopted'),
      mediaType: 'image/png',
    });
    await expect(
      store.readActive({ assetId: adopted.id, projectId: 'another-project', userId })
    ).resolves.toBeNull();

    const states = await sql`
      select id, state
      from public.project_assets
      where workflow_run_id = ${runId}
      order by id
    `;
    expect(states).toEqual(
      [
        { id: adopted.id, state: 'active' },
        { id: unadopted.id, state: 'deletion-pending' },
      ].sort((left, right) => left.id.localeCompare(right.id))
    );
    await sql`
      update public.project_assets
      set deletion_queued_at = '-infinity'::timestamptz
      where id = ${unadopted.id}
    `;

    const claim = await store.claimNextCleanup({ leaseMs: 60_000, workerId: 'asset-cleaner' });
    expect(claim?.id).toBe(unadopted.id);
    if (!claim) throw new Error('Expected an asset cleanup claim.');
    expect(await store.cleanup(claim)).toEqual({ status: 'deleted' });
    expect(storage.objects.size).toBe(1);
    expect([...storage.objects.values()]).toEqual([new TextEncoder().encode('adopted')]);
    expect(await sql`select id from public.project_assets where id = ${unadopted.id}`).toEqual([]);
  });

  test('imports a self-contained backup without synthetic workflow rows', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const importedProjectId = `project-assets-import-${randomUUID()}`;
    const bytes = new TextEncoder().encode('archived visual');
    const ref = {
      byteSize: bytes.byteLength,
      hash: createHash('sha256').update(bytes).digest('hex'),
      id: 'c'.repeat(64),
      mediaType: 'image/png',
    };
    const archive = await createProjectBackupArchive(
      {
        assets: [{ bytes, ref }],
        cover: {
          data: Buffer.from('cover').toString('base64'),
          mimeType: 'image/png',
          name: 'cover.png',
        },
        project: {
          activeSectionId: 'lesson-1',
          createdAt: '2026-07-29T10:00:00.000Z',
          id: 'archived-project',
          isLearnMode: false,
          lastOpenedAt: '2026-07-29T10:00:00.000Z',
          learningPlan: {
            sections: [
              {
                generatedVisuals: [{ render: { asset: ref, kind: 'image' } }],
                id: 'lesson-1',
              },
            ],
          },
          source: null,
          sourceKind: 'document',
          state: 'READING',
          syllabus: [],
          updatedAt: '2026-07-29T10:00:00.000Z',
          userProfile: null,
          version: '4.1',
        },
      },
      {
        invalidArchiveMessage: 'Invalid project backup.',
        maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
        maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
        maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
      }
    );
    const storage = createMemoryStorage();
    const importer = new PostgresProjectAssetImporter(sql, storage);
    const projectStore = new PostgresProjectStore(
      databaseUrl,
      sql,
      undefined,
      new PostgresProjectAssetDeletionQueue(sql, storage),
      importer
    );

    const imported = await projectStore.importProjectArchive(userId, archive, importedProjectId);

    expect(imported.snapshot.id).toBe(importedProjectId);
    const rows = await sql<
      Array<{
        node_instance_id: string | null;
        origin_kind: string;
        workflow_run_id: string | null;
      }>
    >`
      select origin_kind, workflow_run_id, node_instance_id
      from public.project_assets
      where user_id = ${userId} and project_id = ${importedProjectId}
    `;
    expect(rows).toEqual([
      { node_instance_id: null, origin_kind: 'archive-import', workflow_run_id: null },
    ]);
    expect(await projectStore.loadProjectCover(userId, importedProjectId)).toMatchObject({
      data: Buffer.from('cover').toString('base64'),
      mimeType: 'image/png',
      name: 'cover.png',
    });
    expect(
      await sql`select id from public.workflow_runs where project_id = ${importedProjectId}`
    ).toEqual([]);
  });

  test('keeps failed cleanup queued and treats a later 404 as successful deletion', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const runId = await createWorkflowRun();
    const storage = createMemoryStorage();
    const store = new PostgresProjectAssetStore(sql, storage);
    const asset = await store.stage({
      bytes: new TextEncoder().encode('terminal asset'),
      idempotencyKey: 'terminal',
      mediaType: 'image/webp',
      nodeInstanceId,
      projectId,
      runId,
      signal: testSignal,
      userId,
    });
    const [assetObjectPath] = storage.objects.keys();
    if (!assetObjectPath) throw new Error('Expected a staged object path.');
    await sql`
      update public.workflow_runs
      set status = 'failed', completed_at = now()
      where id = ${runId}
    `;
    expect(await store.queueNextTerminalRunAssets()).toBe(1);

    const firstClaim = await store.claimNextCleanup({
      leaseMs: 60_000,
      workerId: 'asset-cleaner-a',
    });
    if (!firstClaim) throw new Error('Expected the first asset cleanup claim.');
    vi.mocked(storage.delete).mockRejectedValueOnce(
      new ProjectSourceStorageError('delete-failed', 503)
    );
    expect(await store.cleanup(firstClaim)).toEqual({ status: 'retrying' });
    await sql`
      update public.project_assets
      set cleanup_lease_expires_at = now() - interval '1 second'
      where id = ${asset.id}
    `;

    const secondClaim = await store.claimNextCleanup({
      leaseMs: 60_000,
      workerId: 'asset-cleaner-b',
    });
    expect(secondClaim?.id).toBe(asset.id);
    if (!secondClaim) throw new Error('Expected the retried asset cleanup claim.');
    storage.objects.delete(assetObjectPath);
    expect(await store.cleanup(secondClaim)).toEqual({ status: 'deleted' });
    expect(await sql`select id from public.project_assets where id = ${asset.id}`).toEqual([]);
  });

  test('rejects a cross-project scope before uploading bytes', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const runId = await createWorkflowRun();
    const storage = createMemoryStorage();
    const store = new PostgresProjectAssetStore(sql, storage);

    await expect(
      store.stage({
        bytes: new TextEncoder().encode('wrong scope'),
        idempotencyKey: 'wrong-scope',
        mediaType: 'image/png',
        nodeInstanceId,
        projectId: 'another-project',
        runId,
        signal: testSignal,
        userId,
      })
    ).rejects.toMatchObject({ code: 'scope-invalid' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('keeps durable staged metadata when Storage upload fails', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const runId = await createWorkflowRun();
    const storage = createMemoryStorage();
    vi.mocked(storage.upload).mockRejectedValueOnce(
      new ProjectSourceStorageError('upload-failed', 503)
    );
    const store = new PostgresProjectAssetStore(sql, storage);

    await expect(
      store.stage({
        bytes: new TextEncoder().encode('retry upload'),
        idempotencyKey: 'retry-upload',
        mediaType: 'image/png',
        nodeInstanceId,
        projectId,
        runId,
        signal: testSignal,
        userId,
      })
    ).rejects.toMatchObject({ code: 'upload-failed' });

    const rows = await sql<Array<{ state: string }>>`
      select state
      from public.project_assets
      where workflow_run_id = ${runId} and idempotency_key = 'retry-upload'
    `;
    expect(rows).toEqual([{ state: 'staged' }]);
  });

  test('isolates the same idempotency key and bytes across different workflow runs', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const firstRunId = await createWorkflowRun();
    const secondRunId = await createWorkflowRun();
    const storage = createMemoryStorage();
    const store = new PostgresProjectAssetStore(sql, storage);
    const common = {
      bytes: new TextEncoder().encode('same bytes'),
      idempotencyKey: 'same-key',
      mediaType: 'image/png',
      nodeInstanceId,
      projectId,
      signal: testSignal,
      userId,
    };

    const first = await store.stage({ ...common, runId: firstRunId });
    const second = await store.stage({ ...common, runId: secondRunId });

    expect(first.id).not.toBe(second.id);
    expect(storage.objects.size).toBe(2);
  });

  test('allows only one worker to claim a queued project deletion', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const objectPath = `integration-claim/${userId}/${randomUUID()}`;
    await sql`
      insert into public.project_asset_deletions (object_path)
      values (${objectPath})
    `;
    const storage = createMemoryStorage();
    const firstQueue = new PostgresProjectAssetDeletionQueue(sql, storage);
    const secondQueue = new PostgresProjectAssetDeletionQueue(sql, storage);

    const claims = await Promise.all([
      firstQueue.claimNextQueuedObject({ leaseMs: 60_000, workerId: 'cleaner-a' }),
      secondQueue.claimNextQueuedObject({ leaseMs: 60_000, workerId: 'cleaner-b' }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(candidate => candidate !== null);
    if (!claim) throw new Error('Expected one project asset deletion claim.');
    expect(claim.objectPath).toBe(objectPath);
    expect(await firstQueue.cleanupQueuedObject(claim)).toBe('deleted');
  });

  test('fences an expired project asset cleanup claim after a concurrent reclaim', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const runId = await createWorkflowRun();
    const storage = createMemoryStorage();
    const firstStore = new PostgresProjectAssetStore(sql, storage);
    const secondStore = new PostgresProjectAssetStore(sql, storage);
    const asset = await firstStore.stage({
      bytes: new TextEncoder().encode('fenced cleanup'),
      idempotencyKey: 'fenced-cleanup',
      mediaType: 'image/png',
      nodeInstanceId,
      projectId,
      runId,
      signal: testSignal,
      userId,
    });
    await sql`
      update public.workflow_runs
      set status = 'failed', completed_at = now()
      where id = ${runId}
    `;
    expect(await firstStore.queueNextTerminalRunAssets()).toBe(1);

    const initialClaims = await Promise.all([
      firstStore.claimNextCleanup({ leaseMs: 60_000, workerId: 'asset-cleaner-a' }),
      secondStore.claimNextCleanup({ leaseMs: 60_000, workerId: 'asset-cleaner-b' }),
    ]);
    expect(initialClaims.filter(Boolean)).toHaveLength(1);
    const staleClaim = initialClaims.find(candidate => candidate !== null);
    if (!staleClaim) throw new Error('Expected one project asset cleanup claim.');
    expect(staleClaim.id).toBe(asset.id);
    await sql`
      update public.project_assets
      set cleanup_lease_expires_at = now() - interval '1 second'
      where id = ${asset.id}
    `;

    const currentClaim = await secondStore.claimNextCleanup({
      leaseMs: 60_000,
      workerId: 'asset-cleaner-current',
    });
    if (!currentClaim) throw new Error('Expected the expired asset cleanup to be reclaimed.');
    expect(currentClaim.fencingToken).toBeGreaterThan(staleClaim.fencingToken);
    await expect(firstStore.cleanup(staleClaim)).rejects.toMatchObject({
      code: 'cleanup-lease-lost',
    });
    await expect(secondStore.cleanup(currentClaim)).resolves.toEqual({ status: 'deleted' });
  });

  test('deletes a project with active and staged assets through durable tombstones', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const deletionProjectId = `project-assets-delete-${randomUUID()}`;
    await sql`
      insert into public.projects (user_id, id, meta, updated_at, last_opened_at)
      values (${userId}, ${deletionProjectId}, '{}'::jsonb, now(), now())
    `;
    const runId = await createWorkflowRun(deletionProjectId);
    const storage = createMemoryStorage();
    const assetStore = new PostgresProjectAssetStore(sql, storage);
    const deletionQueue = new PostgresProjectAssetDeletionQueue(sql, storage);
    const projectStore = new PostgresProjectStore(databaseUrl, sql, undefined, deletionQueue);
    const common = {
      mediaType: 'image/png',
      nodeInstanceId,
      projectId: deletionProjectId,
      runId,
      signal: testSignal,
      userId,
    };
    const active = await assetStore.stage({
      ...common,
      bytes: new TextEncoder().encode('active before project deletion'),
      idempotencyKey: 'active-before-delete',
    });
    await assetStore.stage({
      ...common,
      bytes: new TextEncoder().encode('staged before project deletion'),
      idempotencyKey: 'staged-before-delete',
    });
    await sql.begin(transaction =>
      assetStore.adoptNodeAssets(transaction, {
        assetIds: [active.id],
        nodeInstanceId,
        projectId: deletionProjectId,
        runId,
        userId,
      })
    );

    await expect(projectStore.deleteProject(userId, deletionProjectId)).resolves.toBeUndefined();

    expect(await sql`select id from public.projects where id = ${deletionProjectId}`).toEqual([]);
    expect(await sql`select id, project_id from public.workflow_runs where id = ${runId}`).toEqual([
      { id: runId, project_id: null },
    ]);
    expect(
      await sql`select id from public.project_assets where project_id = ${deletionProjectId}`
    ).toEqual([]);
    const tombstones = await sql<Array<{ object_path: string }>>`
      select object_path
      from public.project_asset_deletions
      where object_path like ${`users/${userId}/projects/%`}
      order by object_path
    `;
    expect(tombstones.map(row => row.object_path).sort()).toEqual(
      [...storage.objects.keys()].sort()
    );

    for (const tombstone of tombstones) {
      const claim = await deletionQueue.claimNextQueuedObject({
        leaseMs: 60_000,
        workerId: 'project-delete-cleaner',
      });
      if (!claim) throw new Error('Expected a project deletion cleanup claim.');
      expect(claim.objectPath).toBe(tombstone.object_path);
      expect(await deletionQueue.cleanupQueuedObject(claim)).toBe('deleted');
    }
    expect(storage.objects.size).toBe(0);
  });

  test('does not hold project deletion open during an in-flight asset upload', async () => {
    if (!sql) throw new Error('Project asset integration database is required.');
    const deletionProjectId = `project-assets-concurrent-delete-${randomUUID()}`;
    await sql`
      insert into public.projects (user_id, id, meta, updated_at, last_opened_at)
      values (${userId}, ${deletionProjectId}, '{}'::jsonb, now(), now())
    `;
    const runId = await createWorkflowRun(deletionProjectId);
    const storage = createMemoryStorage();
    const uploadStarted = createDeferred();
    const releaseUpload = createDeferred();
    const upload = storage.upload;
    storage.upload = vi.fn(async (path, bytes, mediaType) => {
      uploadStarted.resolve();
      await releaseUpload.promise;
      await upload(path, bytes, mediaType);
    });
    const assetStore = new PostgresProjectAssetStore(sql, storage);
    const deletionQueue = new PostgresProjectAssetDeletionQueue(sql, storage);
    const projectStore = new PostgresProjectStore(databaseUrl, sql, undefined, deletionQueue);

    const stageInput = {
      bytes: new TextEncoder().encode('upload while deleting'),
      idempotencyKey: 'concurrent-delete',
      mediaType: 'image/png',
      nodeInstanceId,
      projectId: deletionProjectId,
      runId,
      signal: new AbortController().signal,
      userId,
    };
    const descriptor = buildProjectAssetDescriptor(stageInput);
    const stagePromise = assetStore.stage(stageInput);
    await uploadStarted.promise;
    let deleteSettled = false;
    const deletePromise = projectStore.deleteProject(userId, deletionProjectId).finally(() => {
      deleteSettled = true;
    });
    await deletePromise;
    expect(deleteSettled).toBe(true);

    releaseUpload.resolve();
    await expect(stagePromise).rejects.toMatchObject({ code: 'scope-invalid' });

    expect(await sql`select id from public.projects where id = ${deletionProjectId}`).toEqual([]);
    expect(await sql`select id from public.project_assets where id = ${descriptor.id}`).toEqual([]);
    expect(storage.objects.size).toBe(0);
    const tombstone = await sql<Array<{ object_path: string }>>`
      select object_path
      from public.project_asset_deletions
      where object_path = ${descriptor.objectPath}
    `;
    expect(tombstone).toHaveLength(1);
    const claim = await deletionQueue.claimNextQueuedObject({
      leaseMs: 60_000,
      workerId: 'concurrent-delete-cleaner',
    });
    if (!claim) throw new Error('Expected the concurrent deletion tombstone.');
    expect(await deletionQueue.cleanupQueuedObject(claim)).toBe('deleted');
  });
});
