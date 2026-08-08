import type { TransactionSql } from 'postgres';

import { reconcileProjectAssets } from './projectAssetReconciliation.js';
import { buildProjectMeta } from './projectMeta.js';
import { applyProjectPatch } from './projectPatch.js';
import {
  mergeProjectSnapshotRow,
  splitProjectSnapshot,
  stripProjectRevision,
  toPostgresJson,
} from './projectPersistence.js';
import { ProjectRevisionConflictError } from './projectRevision.js';
import type {
  ProjectPatch,
  ProjectSaveResult,
  ProjectSnapshot,
  SavedProjectMeta,
} from './types.js';

type TransactionProjectPatch = Omit<ProjectPatch, 'updatedAt'>;

interface LockedProjectRow {
  document_index: unknown;
  meta: SavedProjectMeta;
  revision: number | string;
  snapshot: Omit<ProjectSnapshot, 'documentIndex'>;
}

interface ProjectMetaRow {
  meta: SavedProjectMeta;
  revision: number | string;
}

interface ProjectIdRow {
  id: string;
}

export interface LockedProjectSnapshot {
  revision: number;
  snapshot: ProjectSnapshot;
}

export interface TransactionalProjectPatchInput {
  buildPatch: (project: LockedProjectSnapshot) => TransactionProjectPatch | null;
  projectId: string;
  updatedAt: string;
  userId: string;
}

export interface TransactionalProjectSaveResult extends ProjectSaveResult {
  projectChanged: boolean;
}

export class ProjectTransactionTargetNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Progetto ${projectId} non trovato per aggiornamento transazionale.`);
    this.name = 'ProjectTransactionTargetNotFoundError';
  }
}

const lockProjectInTransaction = async (
  transaction: TransactionSql,
  input: { projectId: string; userId: string }
): Promise<{
  currentRevision: number;
  currentSnapshot: ProjectSnapshot;
  row: LockedProjectRow;
}> => {
  const rows = await transaction<LockedProjectRow[]>`
    select
      project.meta,
      project.revision,
      project_snapshot.snapshot,
      project_snapshot.document_index
    from public.projects project
    join public.project_snapshots project_snapshot
      on project_snapshot.user_id = project.user_id and project_snapshot.id = project.id
    where project.user_id = ${input.userId} and project.id = ${input.projectId}
    for update of project, project_snapshot nowait
  `;
  const row = rows[0];
  if (!row) throw new ProjectTransactionTargetNotFoundError(input.projectId);
  return {
    currentRevision: Number(row.revision),
    currentSnapshot: mergeProjectSnapshotRow(row),
    row,
  };
};

/**
 * Applies a project patch while the workflow checkpoint transaction owns the
 * project row lock. The callback performs only synchronous validation and
 * transformation; external work must finish before entering this function.
 */
export const patchProjectInTransaction = async (
  transaction: TransactionSql,
  input: TransactionalProjectPatchInput
): Promise<TransactionalProjectSaveResult> => {
  // Checkpoints already hold workflow rows; waiting behind project deletion would
  // invert the cascade lock order and deadlock both transactions.
  const { currentRevision, currentSnapshot, row } = await lockProjectInTransaction(
    transaction,
    input
  );
  const patch = input.buildPatch({ revision: currentRevision, snapshot: currentSnapshot });
  if (patch === null) {
    return {
      projectChanged: false,
      meta: { ...row.meta, revision: currentRevision },
      snapshot: currentSnapshot,
    };
  }
  const updatedAt =
    Date.parse(currentSnapshot.updatedAt) > Date.parse(input.updatedAt)
      ? currentSnapshot.updatedAt
      : input.updatedAt;
  const snapshot = applyProjectPatch(currentSnapshot, patch, updatedAt);
  const meta = buildProjectMeta(snapshot, { ...row.meta, revision: currentRevision });
  const { documentIndex, snapshotWithoutDocumentIndex } = splitProjectSnapshot(snapshot);

  const metaRows = await transaction<ProjectMetaRow[]>`
    update public.projects
    set meta = ${transaction.json(toPostgresJson(stripProjectRevision(meta)))},
        updated_at = ${meta.updatedAt},
        last_opened_at = ${meta.lastOpenedAt},
        server_updated_at = now(),
        revision = revision + 1
    where user_id = ${input.userId}
      and id = ${input.projectId}
      and revision = ${currentRevision}
    returning meta, revision
  `;
  const savedMeta = metaRows[0];
  if (!savedMeta) {
    throw new ProjectRevisionConflictError();
  }

  const snapshotRows = await transaction<ProjectIdRow[]>`
    update public.project_snapshots
    set snapshot = ${transaction.json(toPostgresJson(snapshotWithoutDocumentIndex))},
        document_index = ${
          documentIndex === null ? null : transaction.json(toPostgresJson(documentIndex))
        },
        updated_at = ${snapshot.updatedAt},
        server_updated_at = now()
    where user_id = ${input.userId} and id = ${input.projectId}
    returning id
  `;
  if (!snapshotRows[0]) {
    throw new ProjectTransactionTargetNotFoundError(input.projectId);
  }
  await reconcileProjectAssets(transaction, {
    previousSnapshot: currentSnapshot,
    projectId: input.projectId,
    snapshot,
    userId: input.userId,
  });

  return {
    projectChanged: true,
    meta: { ...savedMeta.meta, revision: Number(savedMeta.revision) },
    snapshot,
  };
};
