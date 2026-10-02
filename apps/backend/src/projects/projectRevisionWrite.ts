import type postgres from 'postgres';

import {
  type StoredProjectMetaRow,
  splitProjectSnapshot,
  stripProjectRevision,
  toPostgresJson,
} from './projectPersistence.js';
import { ProjectRevisionConflictError } from './projectRevision.js';
import type { ProjectSnapshot, SavedProjectMeta } from './types.js';

export type ProjectWriteSql = postgres.ReservedSql | postgres.TransactionSql;

export interface ProjectMetaRevisionWrite {
  /** Rejects the write unless the stored revision still matches. */
  readonly expectedRevision?: number;
  readonly isNewProject: boolean;
  readonly meta: SavedProjectMeta;
  readonly projectId: string;
  readonly userId: string;
}

/**
 * Writes the next revision of a project's metadata row. This is the only writer of
 * `public.projects` revisions; `isFavorite` keeps the stored value because favorites
 * change through their own narrow update while snapshot writes may carry stale meta.
 */
export const writeProjectMetaRevision = async (
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

/** Writes the snapshot row that pairs with a metadata revision; the only writer of `public.project_snapshots`. */
export const writeProjectSnapshotRow = async (
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
