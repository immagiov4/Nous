import type { ProjectBackupAssetInput } from '@shared/projectBackupArchive';
import {
  buildImportedProjectAssetIdentity,
  collectProjectAssetReferences,
  remapProjectAssetReferences,
} from '@shared/projectBackupAssets';
import type { Sql, TransactionSql } from 'postgres';
import { releaseAdvisoryLockSession } from './projectAdvisoryLockSession.js';
import {
  createProjectAssetStorage,
  ensureProjectAssetUploaded,
  type ProjectAssetObjectStorage,
  ProjectAssetStoreError,
} from './projectAsset.js';
import type { ImportedProjectAssetDescriptor, ProjectSnapshot } from './types.js';

type ReservedSql = Awaited<ReturnType<Sql['reserve']>>;

interface ImportedProjectAssetRow {
  byte_size: number | string;
  content_hash: string;
  id: string;
  idempotency_key: string;
  media_type: string;
  node_instance_id: string | null;
  object_path: string;
  origin_kind: 'archive-import' | 'workflow';
  project_id: string;
  state: 'active' | 'deletion-pending' | 'staged';
  user_id: string;
  workflow_run_id: string | null;
}

export interface PreparedProjectAssetImport {
  readonly assets: readonly ImportedProjectAssetDescriptor[];
  readonly release: () => Promise<void>;
  readonly snapshot: ProjectSnapshot;
}

const collectValidatedArchiveReferences = (
  snapshot: ProjectSnapshot,
  assets: readonly ProjectBackupAssetInput[]
): ReturnType<typeof collectProjectAssetReferences> => {
  // The archive decoder already verified every attachment's bytes and hash. Here we only
  // guard against snapshot normalization changing the reachable asset set or metadata.
  const refs = collectProjectAssetReferences(snapshot);
  const assetsById = new Map(assets.map(asset => [asset.ref.id, asset]));
  if (assetsById.size !== assets.length || assetsById.size !== refs.length) {
    throw new ProjectAssetStoreError('metadata-conflict');
  }
  for (const ref of refs) {
    const asset = assetsById.get(ref.id);
    if (
      asset?.ref.byteSize !== ref.byteSize ||
      asset.ref.hash !== ref.hash ||
      asset.ref.mediaType !== ref.mediaType
    ) {
      throw new ProjectAssetStoreError('metadata-conflict');
    }
  }
  return refs;
};

const lockObjectPaths = async (sql: ReservedSql, objectPaths: readonly string[]): Promise<void> => {
  if (objectPaths.length === 0) return;
  await sql`
    select pg_advisory_lock(hashtextextended(locked.lock_key, 0))
    from jsonb_to_recordset(
      ${sql.json(objectPaths.map(lock_key => ({ lock_key })))}
    ) as locked(lock_key text)
    order by locked.lock_key
  `;
};

const recordCleanupIntents = async (
  sql: ReservedSql,
  objectPaths: readonly string[]
): Promise<void> => {
  if (objectPaths.length === 0) return;
  await sql.unsafe('begin');
  try {
    await sql`
      insert into public.project_asset_deletions (object_path)
      select queued.object_path
      from jsonb_to_recordset(
        ${sql.json(objectPaths.map(object_path => ({ object_path })))}
      ) as queued(object_path text)
      on conflict (object_path) do nothing
    `;
    await sql.unsafe('commit');
  } catch (error) {
    await sql.unsafe('rollback');
    throw error;
  }
};

export class PostgresProjectAssetImporter {
  private storage: ProjectAssetObjectStorage | undefined;

  constructor(
    private readonly sql: Sql,
    storage?: ProjectAssetObjectStorage
  ) {
    this.storage = storage;
  }

  async prepare(input: {
    assets: readonly ProjectBackupAssetInput[];
    projectId: string;
    snapshot: ProjectSnapshot;
    userId: string;
  }): Promise<PreparedProjectAssetImport> {
    const destinationSnapshot = { ...input.snapshot, id: input.projectId };
    const sourceRefs = collectValidatedArchiveReferences(destinationSnapshot, input.assets);
    const idMap = new Map<string, string>();
    const descriptors: ImportedProjectAssetDescriptor[] = [];
    const bytesBySourceId = new Map(input.assets.map(asset => [asset.ref.id, asset.bytes]));
    for (const sourceRef of sourceRefs) {
      const identity = await buildImportedProjectAssetIdentity({
        contentHash: sourceRef.hash,
        projectId: input.projectId,
        sourceAssetId: sourceRef.id,
        userId: input.userId,
      });
      idMap.set(sourceRef.id, identity.id);
      descriptors.push({
        byteSize: sourceRef.byteSize,
        hash: sourceRef.hash,
        id: identity.id,
        idempotencyKey: `archive:${sourceRef.id}`,
        mediaType: sourceRef.mediaType,
        objectPath: identity.objectPath,
      });
    }
    const snapshot = remapProjectAssetReferences(destinationSnapshot, idMap);
    if (descriptors.length === 0) {
      return { assets: [], release: async () => {}, snapshot };
    }

    const reserved = await this.sql.reserve();
    const objectPaths = descriptors
      .map(asset => asset.objectPath)
      .sort((left, right) => left.localeCompare(right));
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await releaseAdvisoryLockSession(reserved);
    };
    try {
      await lockObjectPaths(reserved, objectPaths);
      await recordCleanupIntents(reserved, objectPaths);
      for (const descriptor of descriptors) {
        const sourceAssetId = descriptor.idempotencyKey.slice('archive:'.length);
        const bytes = bytesBySourceId.get(sourceAssetId);
        if (!bytes) throw new ProjectAssetStoreError('metadata-conflict');
        await ensureProjectAssetUploaded(this.getStorage(), descriptor, bytes);
      }
      return { assets: descriptors, release, snapshot };
    } catch (error) {
      await release();
      throw error;
    }
  }

  private getStorage(): ProjectAssetObjectStorage {
    this.storage ??= createProjectAssetStorage({
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      supabaseUrl: process.env.SUPABASE_URL || '',
    });
    return this.storage;
  }
}

const assertPublishedAsset = (
  row: ImportedProjectAssetRow,
  descriptor: ImportedProjectAssetDescriptor,
  input: { projectId: string; userId: string }
): void => {
  if (
    Number(row.byte_size) !== descriptor.byteSize ||
    row.content_hash !== descriptor.hash ||
    row.idempotency_key !== descriptor.idempotencyKey ||
    row.media_type !== descriptor.mediaType ||
    row.node_instance_id !== null ||
    row.object_path !== descriptor.objectPath ||
    row.origin_kind !== 'archive-import' ||
    row.project_id !== input.projectId ||
    row.state !== 'active' ||
    row.user_id !== input.userId ||
    row.workflow_run_id !== null
  ) {
    throw new ProjectAssetStoreError('metadata-conflict');
  }
};

export const publishImportedProjectAssets = async (
  transaction: TransactionSql,
  input: {
    assets: readonly ImportedProjectAssetDescriptor[];
    projectId: string;
    userId: string;
  }
): Promise<void> => {
  if (input.assets.length === 0) return;
  const serializedAssets = input.assets.map(asset => ({
    byte_size: asset.byteSize,
    content_hash: asset.hash,
    id: asset.id,
    idempotency_key: asset.idempotencyKey,
    media_type: asset.mediaType,
    object_path: asset.objectPath,
  }));
  await transaction`
    insert into public.project_assets (
      id, user_id, project_id, origin_kind, workflow_run_id, node_instance_id,
      idempotency_key, content_hash, byte_size, media_type, object_path, state, activated_at
    )
    select
      imported.id, ${input.userId}, ${input.projectId}, 'archive-import', null, null,
      imported.idempotency_key, imported.content_hash, imported.byte_size,
      imported.media_type, imported.object_path, 'active', clock_timestamp()
    from jsonb_to_recordset(${transaction.json(serializedAssets)}) as imported(
      id text,
      idempotency_key text,
      content_hash text,
      byte_size bigint,
      media_type text,
      object_path text
    )
    on conflict (id) do nothing
  `;
  const rows = await transaction<ImportedProjectAssetRow[]>`
    select asset.*
    from public.project_assets asset
    join jsonb_to_recordset(${transaction.json(input.assets.map(asset => ({ id: asset.id })))})
      as imported(id text) on imported.id = asset.id
    where asset.user_id = ${input.userId} and asset.project_id = ${input.projectId}
    order by asset.id
    for update of asset
  `;
  const rowsById = new Map(rows.map(row => [row.id, row]));
  if (rowsById.size !== input.assets.length) throw new ProjectAssetStoreError('metadata-conflict');
  for (const descriptor of input.assets) {
    const row = rowsById.get(descriptor.id);
    if (!row) throw new ProjectAssetStoreError('metadata-conflict');
    assertPublishedAsset(row, descriptor, input);
  }
  await transaction`
    delete from public.project_asset_deletions deletion
    using jsonb_to_recordset(
      ${transaction.json(input.assets.map(asset => ({ object_path: asset.objectPath })))}
    ) as published(object_path text)
    where deletion.object_path = published.object_path
  `;
};
