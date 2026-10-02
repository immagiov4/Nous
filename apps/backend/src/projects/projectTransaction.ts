import type { TransactionSql } from 'postgres';
import { buildProjectMeta } from './projectMeta.js';
import { applyProjectPatch } from './projectPatch.js';
import { mergeProjectSnapshotRow } from './projectPersistence.js';
import { commitProjectRevision } from './projectRevisionWrite.js';
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

export interface LockedProjectSnapshot {
  revision: number;
  snapshot: ProjectSnapshot;
}

export interface TransactionalProjectPatchInput {
  buildPatch: (project: LockedProjectSnapshot) => TransactionProjectPatch | null;
  projectId: string;
  updatedAt: string;
  userId: string;
  waitForProjectLock?: boolean;
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
  input: Pick<TransactionalProjectPatchInput, 'projectId' | 'userId' | 'waitForProjectLock'>
): Promise<{
  currentRevision: number;
  currentSnapshot: ProjectSnapshot;
  row: LockedProjectRow;
}> => {
  const rows = input.waitForProjectLock
    ? await transaction<LockedProjectRow[]>`
      select
        project.meta,
        project.revision,
        project_snapshot.snapshot,
        project_snapshot.document_index
      from public.projects project
      join public.project_snapshots project_snapshot
        on project_snapshot.user_id = project.user_id and project_snapshot.id = project.id
      where project.user_id = ${input.userId} and project.id = ${input.projectId}
      for update of project, project_snapshot
    `
    : await transaction<LockedProjectRow[]>`
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

export interface PlannedProjectRevision {
  meta: SavedProjectMeta;
  snapshot: ProjectSnapshot;
}

/**
 * Computes the next project revision from a locked project, or null when the patch
 * builder declines. Pure, so the Postgres transaction and test adapters share the
 * same timestamp, patch and metadata rules.
 */
export const planProjectPatch = (
  locked: LockedProjectSnapshot & { meta: SavedProjectMeta },
  { buildPatch, updatedAt }: Pick<TransactionalProjectPatchInput, 'buildPatch' | 'updatedAt'>
): PlannedProjectRevision | null => {
  const patch = buildPatch({ revision: locked.revision, snapshot: locked.snapshot });
  if (patch === null) return null;
  const effectiveUpdatedAt =
    Date.parse(locked.snapshot.updatedAt) > Date.parse(updatedAt)
      ? locked.snapshot.updatedAt
      : updatedAt;
  const snapshot = applyProjectPatch(locked.snapshot, patch, effectiveUpdatedAt);
  return {
    meta: buildProjectMeta(snapshot, { ...locked.meta, revision: locked.revision }),
    snapshot,
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
  const planned = planProjectPatch(
    { meta: row.meta, revision: currentRevision, snapshot: currentSnapshot },
    input
  );
  if (!planned) {
    return {
      projectChanged: false,
      meta: { ...row.meta, revision: currentRevision },
      snapshot: currentSnapshot,
    };
  }
  const meta = await commitProjectRevision(transaction, {
    expectedRevision: currentRevision,
    isNewProject: false,
    meta: planned.meta,
    projectId: input.projectId,
    readPreviousSnapshot: async () => currentSnapshot,
    snapshot: planned.snapshot,
    userId: input.userId,
  });
  return { projectChanged: true, meta, snapshot: planned.snapshot };
};
