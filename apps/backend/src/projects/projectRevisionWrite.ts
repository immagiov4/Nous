import type postgres from 'postgres';

import { reconcileProjectAssets } from './projectAssetReconciliation.js';
import {
  mergeProjectMetaRow,
  type StoredProjectMetaRow,
  splitProjectSnapshot,
  stripProjectRevision,
  toPostgresJson,
} from './projectPersistence.js';
import { ProjectRevisionConflictError } from './projectRevision.js';
import type { ProjectSnapshot, SavedProjectMeta } from './types.js';

export type ProjectWriteSql = postgres.ReservedSql | postgres.TransactionSql;

interface ProjectMetaRevisionWrite {
  /** Rejects the write unless the stored revision still matches. */
  readonly expectedRevision?: number;
  readonly isNewProject: boolean;
  readonly meta: SavedProjectMeta;
  readonly projectId: string;
  readonly userId: string;
}

/**
 * `isFavorite` keeps the stored value: favorites change through their own narrow
 * update, while snapshot writes may carry meta read before the row lock.
 */
const writeProjectMetaRevision = async (
  sql: ProjectWriteSql,
  { expectedRevision, isNewProject, meta, projectId, userId }: ProjectMetaRevisionWrite
): Promise<StoredProjectMetaRow> => {
  const serializedMeta = sql.json(toPostgresJson(stripProjectRevision(meta)));
  if (isNewProject) {
    if (expectedRevision !== undefined) throw new ProjectRevisionConflictError();
    const rows = await sql<StoredProjectMetaRow[]>`
      insert into public.projects
        (user_id, id, meta, updated_at, last_opened_at, server_updated_at, revision)
      values
        (${userId}, ${projectId}, ${serializedMeta}, ${meta.updatedAt}, ${meta.lastOpenedAt}, now(), 1)
      returning meta, revision
    `;
    return rows[0];
  }

  const rows = await sql<StoredProjectMetaRow[]>`
    update public.projects
    set meta = jsonb_set(
          ${serializedMeta},
          '{isFavorite}',
          coalesce(meta -> 'isFavorite', 'false'::jsonb),
          true
        ),
        updated_at = ${meta.updatedAt},
        last_opened_at = ${meta.lastOpenedAt},
        server_updated_at = now(),
        revision = revision + 1
    where user_id = ${userId}
      and id = ${projectId}
      and (${expectedRevision ?? null}::bigint is null or revision = ${expectedRevision ?? null})
    returning meta, revision
  `;
  if (!rows[0]) throw new ProjectRevisionConflictError();
  return rows[0];
};

const writeProjectSnapshotRow = async (
  sql: ProjectWriteSql,
  { projectId, snapshot, userId }: { projectId: string; snapshot: ProjectSnapshot; userId: string }
): Promise<void> => {
  const { documentIndex, snapshotWithoutDocumentIndex } = splitProjectSnapshot(snapshot);
  await sql`
    insert into public.project_snapshots
      (user_id, id, snapshot, document_index, updated_at, server_updated_at)
    values
      (
        ${userId},
        ${projectId},
        ${sql.json(toPostgresJson(snapshotWithoutDocumentIndex))},
        ${documentIndex === null ? null : sql.json(toPostgresJson(documentIndex))},
        ${snapshot.updatedAt},
        now()
      )
    on conflict (user_id, id) do update set
      snapshot = excluded.snapshot,
      document_index = excluded.document_index,
      updated_at = excluded.updated_at,
      server_updated_at = excluded.server_updated_at
  `;
};

export interface ProjectRevisionCommit {
  /** Rejects the commit unless the stored revision still matches. */
  readonly expectedRevision?: number;
  readonly isNewProject: boolean;
  readonly meta: SavedProjectMeta;
  readonly projectId: string;
  /** Resolves the snapshot being replaced once the metadata row is written; null for a new project. */
  readonly readPreviousSnapshot: () => Promise<ProjectSnapshot | null>;
  readonly snapshot: ProjectSnapshot;
  readonly userId: string;
  /** Writes rows that reference the project (sources, imported assets, covers) before the snapshot. */
  readonly writeAttachments?: () => Promise<void>;
}

/**
 * Commits one project revision: the metadata row with its revision check, attached
 * rows, the snapshot row, and asset reconciliation against the replaced snapshot.
 * Every new project revision goes through here; callers own locking and building
 * the snapshot and its metadata. Read-time legacy repairs that backfill derived
 * fields without a new revision write the snapshot row directly.
 */
export const commitProjectRevision = async (
  sql: ProjectWriteSql,
  commit: ProjectRevisionCommit
): Promise<SavedProjectMeta> => {
  const { projectId, snapshot, userId } = commit;
  const metaRow = await writeProjectMetaRevision(sql, commit);
  const previousSnapshot = await commit.readPreviousSnapshot();
  await commit.writeAttachments?.();
  await writeProjectSnapshotRow(sql, { projectId, snapshot, userId });
  await reconcileProjectAssets(sql as postgres.TransactionSql, {
    previousSnapshot,
    projectId,
    snapshot,
    userId,
  });
  return mergeProjectMetaRow(metaRow);
};
