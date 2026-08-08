import { isProjectAssetId, type ProjectAssetRef } from '@shared/projectAsset';
import type { Sql, TransactionSql } from 'postgres';

import {
  type AdoptProjectNodeAssetsInput,
  buildProjectAssetDescriptor,
  createProjectAssetStorage,
  ensureProjectAssetUploaded,
  type ProjectAssetCleanupClaim,
  type ProjectAssetDescriptor,
  type ProjectAssetObjectStorage,
  ProjectAssetStoreError,
  type ProjectAssetWriter,
  type StageProjectAssetInput,
} from './projectAsset.js';
import type { ProjectAssetDownload, ProjectAssetReader } from './projectAssetReader.js';
import { ProjectSourceStorageError } from './projectSourceStorage.js';

type ProjectAssetState = 'active' | 'deletion-pending' | 'staged';

interface ProjectAssetRow {
  byte_size: number | string;
  cleanup_fencing_token: number | string;
  cleanup_worker_id: string | null;
  content_hash: string;
  id: string;
  idempotency_key: string;
  media_type: string;
  node_instance_id: string | null;
  object_path: string;
  origin_kind: 'archive-import' | 'workflow';
  project_id: string;
  state: ProjectAssetState;
  user_id: string;
  workflow_run_id: string | null;
}

const mapRef = (row: ProjectAssetRow): ProjectAssetRef =>
  Object.freeze({
    byteSize: Number(row.byte_size),
    hash: row.content_hash,
    id: row.id,
    mediaType: row.media_type,
  });

const normalizeAssetIds = (assetIds: readonly string[]): string[] => {
  const normalized = [...new Set(assetIds.map(id => id.trim()))];
  if (normalized.some(id => !isProjectAssetId(id))) {
    throw new ProjectAssetStoreError('asset-not-adoptable');
  }
  return normalized.sort((left, right) => left.localeCompare(right));
};

const assertStoredDescriptor = (
  row: ProjectAssetRow,
  descriptor: ReturnType<typeof buildProjectAssetDescriptor>,
  input: StageProjectAssetInput
): void => {
  if (row.byte_size !== descriptor.byteSize && Number(row.byte_size) !== descriptor.byteSize) {
    throw new ProjectAssetStoreError('metadata-conflict');
  }
  if (
    row.content_hash !== descriptor.hash ||
    row.idempotency_key !== descriptor.idempotencyKey ||
    row.media_type !== descriptor.mediaType ||
    row.origin_kind !== 'workflow' ||
    row.node_instance_id !== input.nodeInstanceId ||
    row.object_path !== descriptor.objectPath ||
    row.project_id !== input.projectId ||
    row.user_id !== input.userId ||
    row.workflow_run_id !== input.runId
  ) {
    throw new ProjectAssetStoreError('metadata-conflict');
  }
  if (row.state === 'deletion-pending') {
    throw new ProjectAssetStoreError('asset-not-adoptable');
  }
};

const assertCleanupInput = (input: { leaseMs: number; workerId: string }): void => {
  if (!input.workerId.trim() || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new ProjectAssetStoreError('invalid-cleanup-claim');
  }
};

export class PostgresProjectAssetStore implements ProjectAssetReader, ProjectAssetWriter {
  private readonly storage: ProjectAssetObjectStorage;

  constructor(
    private readonly sql: Sql,
    storage?: ProjectAssetObjectStorage
  ) {
    this.storage =
      storage ??
      createProjectAssetStorage({
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        supabaseUrl: process.env.SUPABASE_URL || '',
      });
  }

  async stage(input: StageProjectAssetInput): Promise<ProjectAssetRef> {
    const descriptor = buildProjectAssetDescriptor(input);
    const row = await this.insertStagedMetadata(input, descriptor);
    await this.uploadStagedObject(input, descriptor);
    return mapRef(row);
  }

  private async insertStagedMetadata(
    input: StageProjectAssetInput,
    descriptor: ProjectAssetDescriptor
  ): Promise<ProjectAssetRow> {
    return this.sql.begin(async sql => {
      const projects = await sql<Array<{ found: number }>>`
        select 1 as found
        from public.projects
        where user_id = ${input.userId} and id = ${input.projectId}
        for key share
      `;
      if (!projects[0]) throw new ProjectAssetStoreError('scope-invalid');
      const runs = await sql<Array<{ found: number }>>`
        select 1 as found
        from public.workflow_runs
        where id = ${input.runId}
          and user_id = ${input.userId}
          and project_id = ${input.projectId}
          and status in ('queued', 'running', 'waiting')
        for share
      `;
      if (!runs[0]) throw new ProjectAssetStoreError('scope-invalid');
      const nodes = await sql<Array<{ found: number }>>`
        select 1 as found
        from public.workflow_node_runs
        where run_id = ${input.runId}
          and node_instance_id = ${input.nodeInstanceId}
          and status = 'running'
      `;
      if (!nodes[0]) throw new ProjectAssetStoreError('scope-invalid');
      await sql`
        insert into public.project_assets (
          id, user_id, project_id, origin_kind, workflow_run_id, node_instance_id, idempotency_key,
          content_hash, byte_size, media_type, object_path
        )
        select
          ${descriptor.id}, run.user_id, run.project_id, 'workflow', run.id, node.node_instance_id,
          ${descriptor.idempotencyKey}, ${descriptor.hash}, ${descriptor.byteSize},
          ${descriptor.mediaType}, ${descriptor.objectPath}
        from public.workflow_runs run
        join public.workflow_node_runs node
          on node.run_id = run.id and node.node_instance_id = ${input.nodeInstanceId}
        where run.id = ${input.runId}
          and run.user_id = ${input.userId}
          and run.project_id = ${input.projectId}
        on conflict (id) do nothing
      `;
      const rows = await sql<ProjectAssetRow[]>`
        select *
        from public.project_assets
        where id = ${descriptor.id}
          and user_id = ${input.userId}
          and project_id = ${input.projectId}
        for update
      `;
      if (!rows[0]) throw new ProjectAssetStoreError('scope-invalid');
      assertStoredDescriptor(rows[0], descriptor, input);
      return rows[0];
    });
  }

  private async uploadStagedObject(
    input: StageProjectAssetInput,
    descriptor: ProjectAssetDescriptor
  ): Promise<void> {
    await ensureProjectAssetUploaded(this.storage, descriptor, input.bytes, input.signal);
    input.signal.throwIfAborted();
    try {
      await this.validateUploadedObject(input, descriptor);
    } catch (error) {
      if (error instanceof ProjectAssetStoreError && error.code === 'scope-invalid') {
        await this.storage.delete(descriptor.objectPath);
      }
      throw error;
    }
  }

  private async validateUploadedObject(
    input: StageProjectAssetInput,
    descriptor: ProjectAssetDescriptor
  ): Promise<void> {
    await this.sql.begin(async sql => {
      const projects = await sql<Array<{ found: number }>>`
        select 1 as found
        from public.projects
        where user_id = ${input.userId} and id = ${input.projectId}
        for key share
      `;
      if (!projects[0]) throw new ProjectAssetStoreError('scope-invalid');
      const runs = await sql<Array<{ found: number }>>`
        select 1 as found
        from public.workflow_runs
        where id = ${input.runId}
          and user_id = ${input.userId}
          and project_id = ${input.projectId}
          and status in ('queued', 'running', 'waiting')
        for share
      `;
      if (!runs[0]) throw new ProjectAssetStoreError('scope-invalid');
      const rows = await sql<ProjectAssetRow[]>`
        select asset.*
        from public.project_assets asset
        join public.workflow_node_runs node
          on node.run_id = asset.workflow_run_id
         and node.node_instance_id = asset.node_instance_id
        where asset.id = ${descriptor.id}
          and asset.user_id = ${input.userId}
          and asset.project_id = ${input.projectId}
          and node.status = 'running'
        for update of asset
      `;
      if (!rows[0]) throw new ProjectAssetStoreError('scope-invalid');
      assertStoredDescriptor(rows[0], descriptor, input);
    });
  }

  async readActive(input: {
    assetId: string;
    projectId: string;
    userId: string;
  }): Promise<ProjectAssetDownload | null> {
    const rows = await this.sql<ProjectAssetRow[]>`
      select asset.*
      from public.project_assets asset
      where asset.id = ${input.assetId}
        and asset.user_id = ${input.userId}
        and asset.project_id = ${input.projectId}
        and asset.state = 'active'
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const bytes = await this.storage.download(row.object_path, {
      byteSize: Number(row.byte_size),
      hash: row.content_hash,
      mimeType: row.media_type,
    });
    return Object.freeze({ bytes, mediaType: row.media_type });
  }

  async adoptNodeAssets(
    sql: TransactionSql,
    input: AdoptProjectNodeAssetsInput
  ): Promise<readonly ProjectAssetRef[]> {
    const assetIds = normalizeAssetIds(input.assetIds);
    const rows = await this.lockNodeAssets(sql, input, assetIds);
    if (rows.some(row => row.state === 'deletion-pending')) {
      throw new ProjectAssetStoreError('asset-not-adoptable');
    }

    if (assetIds.length > 0) {
      await sql`
        update public.project_assets
        set state = 'active',
            activated_at = coalesce(activated_at, clock_timestamp()),
            deletion_queued_at = null,
            cleanup_worker_id = null,
            cleanup_lease_expires_at = null,
            last_cleanup_error = null
        where id in ${sql(assetIds)}
          and user_id = ${input.userId}
          and project_id = ${input.projectId}
      `;
    }

    await this.queueUnadoptedNodeAssets(sql, input, assetIds);
    const byId = new Map(rows.map(row => [row.id, mapRef(row)]));
    return Object.freeze(assetIds.map(id => byId.get(id) as ProjectAssetRef));
  }

  async queueNextTerminalRunAssets(): Promise<number> {
    return this.sql.begin(async sql => {
      const queued = await sql<Array<{ id: string }>>`
        with terminal_run as (
          select run.id
          from public.workflow_runs run
          where run.status in ('cancelled', 'completed', 'expired', 'failed')
            and exists (
          select 1
          from public.project_assets asset
              where asset.origin_kind = 'workflow'
                and asset.workflow_run_id = run.id
                and asset.state = 'staged'
            )
          order by run.completed_at, run.id
          for update skip locked
          limit 1
        )
        update public.project_assets asset
        set state = 'deletion-pending',
            deletion_queued_at = coalesce(asset.deletion_queued_at, clock_timestamp())
        where asset.workflow_run_id = (select id from terminal_run)
          and asset.origin_kind = 'workflow'
          and asset.state = 'staged'
        returning asset.id
      `;
      return queued.length;
    });
  }

  async claimNextCleanup(input: {
    leaseMs: number;
    workerId: string;
  }): Promise<ProjectAssetCleanupClaim | null> {
    assertCleanupInput(input);
    return this.sql.begin(async sql => {
      const rows = await sql<ProjectAssetRow[]>`
        with candidate as (
          select asset.id
          from public.project_assets asset
          where asset.state = 'deletion-pending'
            and (
              asset.cleanup_lease_expires_at is null
              or asset.cleanup_lease_expires_at <= clock_timestamp()
            )
          order by asset.cleanup_attempt_count, asset.deletion_queued_at, asset.id
          for update skip locked
          limit 1
        )
        update public.project_assets asset
        set cleanup_worker_id = ${input.workerId},
            cleanup_lease_expires_at = clock_timestamp() + ${input.leaseMs} * interval '1 millisecond',
            cleanup_fencing_token = asset.cleanup_fencing_token + 1,
            cleanup_attempt_count = asset.cleanup_attempt_count + 1
        from candidate
        where asset.id = candidate.id
        returning asset.*
      `;
      const row = rows[0];
      return row
        ? Object.freeze({
            ...mapRef(row),
            fencingToken: Number(row.cleanup_fencing_token),
            objectPath: row.object_path,
            workerId: input.workerId,
          })
        : null;
    });
  }

  async cleanup(claim: ProjectAssetCleanupClaim): Promise<{ status: 'deleted' | 'retrying' }> {
    const readiness = await this.readCleanupReadiness(claim);
    if (readiness === 'already-deleted') return { status: 'deleted' };

    try {
      await this.storage.delete(claim.objectPath);
    } catch (error) {
      if (!(error instanceof ProjectSourceStorageError) || error.status !== 404) {
        await this.recordFailedCleanup(claim, error);
        return { status: 'retrying' };
      }
    }

    const deleted = await this.sql<Array<{ id: string }>>`
      delete from public.project_assets asset
      where asset.id = ${claim.id}
        and asset.state = 'deletion-pending'
        and asset.cleanup_worker_id = ${claim.workerId}
        and asset.cleanup_fencing_token = ${claim.fencingToken}
      returning asset.id
    `;
    if (!deleted[0]) throw new ProjectAssetStoreError('cleanup-lease-lost');
    return { status: 'deleted' };
  }

  private async lockNodeAssets(
    sql: TransactionSql,
    input: AdoptProjectNodeAssetsInput,
    assetIds: readonly string[]
  ): Promise<ProjectAssetRow[]> {
    if (assetIds.length === 0) return [];
    const rows = await sql<ProjectAssetRow[]>`
      select *
      from public.project_assets
      where id in ${sql(assetIds)}
        and user_id = ${input.userId}
        and project_id = ${input.projectId}
        and workflow_run_id = ${input.runId}
        and node_instance_id = ${input.nodeInstanceId}
        and origin_kind = 'workflow'
      order by id
      for update
    `;
    if (rows.length !== assetIds.length) {
      throw new ProjectAssetStoreError('asset-not-adoptable');
    }
    return rows;
  }

  private async queueUnadoptedNodeAssets(
    sql: TransactionSql,
    input: AdoptProjectNodeAssetsInput,
    adoptedIds: readonly string[]
  ): Promise<void> {
    if (adoptedIds.length === 0) {
      await sql`
        update public.project_assets
        set state = 'deletion-pending', deletion_queued_at = clock_timestamp()
        where workflow_run_id = ${input.runId}
          and node_instance_id = ${input.nodeInstanceId}
          and origin_kind = 'workflow'
          and user_id = ${input.userId}
          and project_id = ${input.projectId}
          and state = 'staged'
      `;
      return;
    }
    await sql`
      update public.project_assets
      set state = 'deletion-pending', deletion_queued_at = clock_timestamp()
      where workflow_run_id = ${input.runId}
        and node_instance_id = ${input.nodeInstanceId}
        and origin_kind = 'workflow'
        and user_id = ${input.userId}
        and project_id = ${input.projectId}
        and state = 'staged'
        and id not in ${sql(adoptedIds)}
    `;
  }

  private async readCleanupReadiness(
    claim: ProjectAssetCleanupClaim
  ): Promise<'already-deleted' | 'ready'> {
    return this.sql.begin(async sql => {
      const rows = await sql<
        Array<{
          cleanup_fencing_token: number | string;
          cleanup_worker_id: string | null;
          object_path: string;
          state: ProjectAssetState;
        }>
      >`
        select
          asset.state,
          asset.cleanup_worker_id,
          asset.cleanup_fencing_token,
          asset.object_path
        from public.project_assets asset
        where asset.id = ${claim.id}
        for update
      `;
      const row = rows[0];
      if (!row) return 'already-deleted';
      if (
        row.cleanup_worker_id !== claim.workerId ||
        Number(row.cleanup_fencing_token) !== claim.fencingToken
      ) {
        throw new ProjectAssetStoreError('cleanup-lease-lost');
      }
      if (row.object_path !== claim.objectPath) {
        throw new ProjectAssetStoreError('invalid-cleanup-claim');
      }
      if (row.state === 'deletion-pending') return 'ready';
      throw new ProjectAssetStoreError('cleanup-lease-lost');
    });
  }

  private async recordFailedCleanup(
    claim: ProjectAssetCleanupClaim,
    error: unknown
  ): Promise<void> {
    const code = error instanceof ProjectSourceStorageError ? error.code : 'unknown';
    const status = error instanceof ProjectSourceStorageError ? (error.status ?? null) : null;
    const released = await this.sql<Array<{ id: string }>>`
      update public.project_assets
      set last_cleanup_error = ${this.sql.json({ code, status })}
      where id = ${claim.id}
        and state = 'deletion-pending'
        and cleanup_worker_id = ${claim.workerId}
        and cleanup_fencing_token = ${claim.fencingToken}
      returning id
    `;
    if (!released[0]) throw new ProjectAssetStoreError('cleanup-lease-lost');
  }
}
