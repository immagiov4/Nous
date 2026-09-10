import type { DiagnosticSnapshotRef } from '@shared/priorKnowledgePlanning.js';
import type { Sql, TransactionSql } from 'postgres';
import { toPostgresJson } from '../../projects/projectPersistence.js';
import {
  type DiagnosticSnapshot,
  DiagnosticSnapshotSchema,
} from '../priorKnowledgeDiagnosticSnapshot.js';

/** Immutable course-owned records; no foreign key to disposable workflow history. */
export class PostgresDiagnosticSnapshotStore {
  constructor(private readonly sql: Sql) {}

  // fallow-ignore-next-line unused-class-member -- Called through the interview draft-lifetime store contract.
  async hasAcceptedSubmission(userId: string, projectId: string): Promise<boolean> {
    const [result] = await this.sql<{ submitted: boolean }[]>`
      select exists (
        select 1 from public.prior_knowledge_diagnostic_snapshots diagnostic
        join public.projects project on project.user_id = diagnostic.user_id
          and project.id = diagnostic.project_id and project.incarnation_id = diagnostic.incarnation_id
        where diagnostic.user_id = ${userId} and diagnostic.project_id = ${projectId}
          and jsonb_path_exists(diagnostic.snapshot, '$.collection.passes[*].submission')
      ) as submitted
    `;
    return result.submitted;
  }

  // fallow-ignore-next-line unused-class-member -- Bound by courseGenerationProduction as the preparation loader.
  async load(userId: string, ref: DiagnosticSnapshotRef): Promise<DiagnosticSnapshot | null> {
    if (userId !== ref.userId) return null;
    const rows = await this.sql<{ snapshot: unknown }[]>`
      select diagnostic.snapshot
      from public.prior_knowledge_diagnostic_snapshots diagnostic
      join public.projects project on project.user_id = diagnostic.user_id
        and project.id = diagnostic.project_id and project.incarnation_id = diagnostic.incarnation_id
      where diagnostic.user_id = ${userId} and diagnostic.project_id = ${ref.projectId}
        and diagnostic.incarnation_id = ${ref.incarnationId}
        and diagnostic.diagnostic_id = ${ref.diagnosticId} and diagnostic.revision_id = ${ref.revisionId}
    `;
    return rows[0] ? DiagnosticSnapshotSchema.parse(rows[0].snapshot) : null;
  }
}

export async function saveDiagnosticSnapshot(
  transaction: TransactionSql,
  snapshot: DiagnosticSnapshot
): Promise<void> {
  const parsed = DiagnosticSnapshotSchema.parse(snapshot);
  const { ref } = parsed;
  if (
    ref.projectId !== parsed.collection.projectId ||
    ref.diagnosticId !== parsed.collection.collectionId
  ) {
    throw new Error('Diagnostic snapshot identity does not match its collection.');
  }
  const rows = await transaction<{ snapshot: unknown }[]>`
    insert into public.prior_knowledge_diagnostic_snapshots
      (user_id, project_id, incarnation_id, diagnostic_id, revision_id, snapshot, recorded_at)
    select ${ref.userId}, project.id, project.incarnation_id, ${ref.diagnosticId}, ${ref.revisionId},
      ${transaction.json(toPostgresJson(parsed))}, ${parsed.recordedAt}
    from public.projects project
    where project.user_id = ${ref.userId} and project.id = ${ref.projectId}
      and project.incarnation_id = ${ref.incarnationId}
    on conflict do nothing returning snapshot
  `;
  if (rows.length) return;
  const existing = await transaction<{ matches: boolean }[]>`
    select snapshot = ${transaction.json(toPostgresJson(parsed))} as matches
    from public.prior_knowledge_diagnostic_snapshots
    where user_id = ${ref.userId} and project_id = ${ref.projectId}
      and incarnation_id = ${ref.incarnationId} and diagnostic_id = ${ref.diagnosticId}
      and revision_id = ${ref.revisionId}
  `;
  if (!existing[0]?.matches)
    throw new Error('Diagnostic snapshot is missing or immutable revision differs.');
}
