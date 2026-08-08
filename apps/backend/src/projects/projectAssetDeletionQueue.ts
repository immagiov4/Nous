import type { Sql, TransactionSql } from 'postgres';
import { releaseAdvisoryLockSession } from './projectAdvisoryLockSession.js';
import {
  createProjectAssetStorage,
  type ProjectAssetObjectStorage,
  ProjectAssetStoreError,
} from './projectAsset.js';
import { ProjectSourceStorageError } from './projectSourceStorage.js';

interface ProjectAssetDeletionRow {
  cleanup_fencing_token: number | string;
  cleanup_worker_id: string | null;
  object_path: string;
}

type ReservedSql = Awaited<ReturnType<Sql['reserve']>>;

export interface ProjectAssetDeletionClaim {
  readonly fencingToken: number;
  readonly objectPath: string;
  readonly workerId: string;
}

export interface ProjectAssetDeletionQueue {
  cleanupQueuedObject(claim: ProjectAssetDeletionClaim): Promise<'deleted' | 'retrying'>;
  claimNextQueuedObject(input: {
    leaseMs: number;
    workerId: string;
  }): Promise<ProjectAssetDeletionClaim | null>;
  queueProjectAssets(
    transaction: TransactionSql,
    input: { projectId: string; userId: string }
  ): Promise<readonly string[]>;
}

const assertClaimInput = (input: { leaseMs: number; workerId: string }): void => {
  if (!input.workerId.trim() || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new ProjectAssetStoreError('invalid-cleanup-claim');
  }
};

export class PostgresProjectAssetDeletionQueue implements ProjectAssetDeletionQueue {
  private storage: ProjectAssetObjectStorage | undefined;

  constructor(
    private readonly sql: Sql,
    storage?: ProjectAssetObjectStorage
  ) {
    this.storage = storage;
  }

  async queueProjectAssets(
    transaction: TransactionSql,
    input: { projectId: string; userId: string }
  ): Promise<readonly string[]> {
    const rows = await transaction<Array<{ object_path: string }>>`
      select object_path
      from public.project_assets
      where user_id = ${input.userId} and project_id = ${input.projectId}
      order by object_path
      for update
    `;
    const objectPaths = rows.map(row => row.object_path);
    if (objectPaths.length === 0) return [];
    await transaction`
      insert into public.project_asset_deletions (object_path)
      select queued.object_path
      from jsonb_to_recordset(${transaction.json(objectPaths.map(object_path => ({ object_path })))})
        as queued(object_path text)
      on conflict (object_path) do nothing
    `;
    await transaction`
      delete from public.project_assets
      where user_id = ${input.userId} and project_id = ${input.projectId}
    `;
    return objectPaths;
  }

  async claimNextQueuedObject(input: {
    leaseMs: number;
    workerId: string;
  }): Promise<ProjectAssetDeletionClaim | null> {
    assertClaimInput(input);
    const rows = await this.sql<ProjectAssetDeletionRow[]>`
      with candidate as (
        select object_path
        from public.project_asset_deletions
        where cleanup_lease_expires_at is null
           or cleanup_lease_expires_at <= clock_timestamp()
        order by attempt_count, created_at, object_path
        for update skip locked
        limit 1
      )
      update public.project_asset_deletions deletion
      set attempt_count = deletion.attempt_count + 1,
          cleanup_worker_id = ${input.workerId},
          cleanup_lease_expires_at = clock_timestamp() + ${input.leaseMs} * interval '1 millisecond',
          cleanup_fencing_token = deletion.cleanup_fencing_token + 1
      from candidate
      where deletion.object_path = candidate.object_path
      returning deletion.object_path, deletion.cleanup_worker_id, deletion.cleanup_fencing_token
    `;
    const row = rows[0];
    return row
      ? {
          fencingToken: Number(row.cleanup_fencing_token),
          objectPath: row.object_path,
          workerId: input.workerId,
        }
      : null;
  }

  async cleanupQueuedObject(claim: ProjectAssetDeletionClaim): Promise<'deleted' | 'retrying'> {
    const reserved = await this.sql.reserve();
    let lockAcquired = false;
    try {
      const lockRows = await reserved<Array<{ acquired: boolean }>>`
        select pg_try_advisory_lock(hashtextextended(${claim.objectPath}, 0)) as acquired
      `;
      lockAcquired = lockRows[0]?.acquired === true;
      if (!lockAcquired) {
        await this.releaseClaimForRetry(reserved, claim);
        return 'retrying';
      }
      await this.assertCurrentClaim(reserved, claim);
      const activeRows = await reserved<Array<{ found: number }>>`
        select 1 as found
        from public.project_assets
        where object_path = ${claim.objectPath} and state = 'active'
        limit 1
      `;
      if (activeRows[0]) {
        await this.deleteCurrentTombstone(reserved, claim);
        return 'deleted';
      }
      try {
        await this.getStorage().delete(claim.objectPath);
      } catch (error) {
        if (!(error instanceof ProjectSourceStorageError) || error.status !== 404) {
          await this.recordFailure(reserved, claim, error);
          return 'retrying';
        }
      }
      await this.deleteCurrentTombstone(reserved, claim);
      return 'deleted';
    } finally {
      await releaseAdvisoryLockSession(reserved);
    }
  }

  private async deleteCurrentTombstone(
    sql: ReservedSql,
    claim: ProjectAssetDeletionClaim
  ): Promise<void> {
    const deleted = await sql<Array<{ object_path: string }>>`
      delete from public.project_asset_deletions
      where object_path = ${claim.objectPath}
        and cleanup_worker_id = ${claim.workerId}
        and cleanup_fencing_token = ${claim.fencingToken}
      returning object_path
    `;
    if (!deleted[0]) throw new ProjectAssetStoreError('cleanup-lease-lost');
  }

  private async assertCurrentClaim(
    sql: ReservedSql,
    claim: ProjectAssetDeletionClaim
  ): Promise<void> {
    const rows = await sql<ProjectAssetDeletionRow[]>`
      select object_path, cleanup_worker_id, cleanup_fencing_token
      from public.project_asset_deletions
      where object_path = ${claim.objectPath}
    `;
    const row = rows[0];
    if (
      row?.cleanup_worker_id !== claim.workerId ||
      Number(row?.cleanup_fencing_token) !== claim.fencingToken
    ) {
      throw new ProjectAssetStoreError('cleanup-lease-lost');
    }
  }

  private async releaseClaimForRetry(
    sql: ReservedSql,
    claim: ProjectAssetDeletionClaim
  ): Promise<void> {
    const rows = await sql<Array<{ object_path: string }>>`
      update public.project_asset_deletions
      set cleanup_worker_id = null, cleanup_lease_expires_at = null
      where object_path = ${claim.objectPath}
        and cleanup_worker_id = ${claim.workerId}
        and cleanup_fencing_token = ${claim.fencingToken}
      returning object_path
    `;
    if (!rows[0]) throw new ProjectAssetStoreError('cleanup-lease-lost');
  }

  private async recordFailure(
    sql: ReservedSql,
    claim: ProjectAssetDeletionClaim,
    error: unknown
  ): Promise<void> {
    const code = error instanceof ProjectSourceStorageError ? error.code : 'unknown';
    const status = error instanceof ProjectSourceStorageError ? (error.status ?? null) : null;
    const rows = await sql<Array<{ object_path: string }>>`
      update public.project_asset_deletions
      set last_error = ${this.sql.json({ code, status })}
      where object_path = ${claim.objectPath}
        and cleanup_worker_id = ${claim.workerId}
        and cleanup_fencing_token = ${claim.fencingToken}
      returning object_path
    `;
    if (!rows[0]) throw new ProjectAssetStoreError('cleanup-lease-lost');
  }

  private getStorage(): ProjectAssetObjectStorage {
    this.storage ??= createProjectAssetStorage({
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      supabaseUrl: process.env.SUPABASE_URL || '',
    });
    return this.storage;
  }
}
