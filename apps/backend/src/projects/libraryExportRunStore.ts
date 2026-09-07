import type {
  LibraryArchiveProjectEntry,
  LibraryExportPhase,
  LibraryExportStatus,
} from '@shared/libraryExportContract';
import type { LibraryFolder, LibraryPlacement } from '@shared/projectContract';
import postgres, { type Sql } from 'postgres';
import * as z from 'zod';

import { toPostgresJson } from './projectPersistence.js';

export interface LibraryExportProjectCheckpoint {
  archiveBytes: number;
  archivePath: string;
  archiveSha256: string;
  projectIncarnationId?: string;
  projectId: string;
  projectIndex: number;
  projectRevision?: number;
}

export interface LibraryExportExpectedProject extends LibraryArchiveProjectEntry {
  incarnationId?: string;
  revision?: number;
}

export interface LibraryExportRunRecord {
  archiveBytes?: number;
  archiveSha256?: string;
  bytesWritten: number;
  checkpoints: LibraryExportProjectCheckpoint[];
  correlationId: string;
  currentProjectId?: string;
  errorCode?: string;
  errorDetail?: string;
  errorPhase?: LibraryExportPhase;
  expectedProjects: LibraryExportExpectedProject[];
  folders: LibraryFolder[];
  id: string;
  phase: LibraryExportPhase;
  placements: LibraryPlacement[];
  status: LibraryExportStatus;
  userId: string;
}

export interface LibraryExportRunProgressRecord {
  archiveBytes?: number;
  bytesWritten: number;
  completedProjectCount: number;
  correlationId: string;
  currentProjectId?: string;
  errorCode?: string;
  errorPhase?: LibraryExportPhase;
  id: string;
  phase: LibraryExportPhase;
  projectCount: number;
  status: LibraryExportStatus;
  userId: string;
}

export interface LibraryExportRunStore {
  authorizeDownload(userId: string, runId: string, tokenSha256: string): Promise<boolean>;
  claimDownload(runId: string, tokenSha256: string): Promise<LibraryExportRunRecord | null>;
  checkpointProject(runId: string, checkpoint: LibraryExportProjectCheckpoint): Promise<void>;
  createRun(input: Omit<LibraryExportRunRecord, 'checkpoints'>): Promise<LibraryExportRunRecord>;
  findUndeliveredRun(userId: string): Promise<LibraryExportRunRecord | null>;
  getRun(userId: string, runId: string): Promise<LibraryExportRunRecord | null>;
  getRunProgress(userId: string, runId: string): Promise<LibraryExportRunProgressRecord | null>;
  listPendingCleanupRunIds(): Promise<string[]>;
  listRunningRuns(): Promise<LibraryExportRunRecord[]>;
  markCancelled(
    runId: string,
    error: { code: string; detail: string; phase: LibraryExportPhase }
  ): Promise<void>;
  markCompleted(runId: string, archive: { bytes: number; sha256: string }): Promise<boolean>;
  markCleanupCompleted(runId: string): Promise<void>;
  markDownloaded(runId: string): Promise<void>;
  markFailed(
    runId: string,
    error: { code: string; detail: string; phase: LibraryExportPhase }
  ): Promise<void>;
  markRunning(runId: string, phase: LibraryExportPhase, currentProjectId?: string): Promise<void>;
}

interface LibraryExportRunRow {
  archive_bytes: number | string | null;
  archive_sha256: string | null;
  bytes_written: number | string;
  correlation_id: string;
  current_project_id: string | null;
  error_code: string | null;
  error_detail: string | null;
  error_phase: string | null;
  expected_projects: unknown;
  folders: unknown;
  id: string;
  phase: string;
  placements: unknown;
  status: string;
  user_id: string;
}

interface LibraryExportCheckpointRow {
  archive_bytes: number | string;
  archive_path: string;
  archive_sha256: string;
  project_incarnation_id: string | null;
  project_id: string;
  project_index: number;
  project_revision: number | string | null;
}

interface LibraryExportRunProgressRow {
  archive_bytes: number | string | null;
  bytes_written: number | string;
  completed_project_count: number | string;
  correlation_id: string;
  current_project_id: string | null;
  error_code: string | null;
  error_phase: string | null;
  id: string;
  phase: string;
  project_count: number | string;
  status: string;
  user_id: string;
}

const projectEntrySchema = z.object({
  id: z.string(),
  incarnationId: z.string().optional(),
  path: z.string(),
  revision: z.number().int().nonnegative().optional(),
  title: z.string(),
});
const folderSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
  name: z.string(),
  order: z.number(),
  parentFolderId: z.string().nullable(),
  updatedAt: z.string(),
});
const placementSchema = z.object({
  folderId: z.string().nullable(),
  order: z.number(),
  projectId: z.string(),
  updatedAt: z.string(),
});
const statusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'downloaded']);
const phaseSchema = z.enum([
  'preparing',
  'project-archive',
  'library-archive',
  'integrity-check',
  'ready',
  'failed',
]);

const toSafeNumber = (value: number | string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Persisted library export byte count is invalid.');
  }
  return parsed;
};

const mapCheckpoint = (row: LibraryExportCheckpointRow): LibraryExportProjectCheckpoint => ({
  archiveBytes: toSafeNumber(row.archive_bytes),
  archivePath: row.archive_path,
  archiveSha256: row.archive_sha256,
  ...(row.project_incarnation_id === null
    ? {}
    : { projectIncarnationId: row.project_incarnation_id }),
  projectId: row.project_id,
  projectIndex: row.project_index,
  ...(row.project_revision === null ? {} : { projectRevision: toSafeNumber(row.project_revision) }),
});

const mapRunProgress = (row: LibraryExportRunProgressRow): LibraryExportRunProgressRecord => ({
  ...(row.archive_bytes === null ? {} : { archiveBytes: toSafeNumber(row.archive_bytes) }),
  bytesWritten: toSafeNumber(row.bytes_written),
  completedProjectCount: toSafeNumber(row.completed_project_count),
  correlationId: row.correlation_id,
  ...(row.current_project_id ? { currentProjectId: row.current_project_id } : {}),
  ...(row.error_code ? { errorCode: row.error_code } : {}),
  ...(row.error_phase ? { errorPhase: phaseSchema.parse(row.error_phase) } : {}),
  id: row.id,
  phase: phaseSchema.parse(row.phase),
  projectCount: toSafeNumber(row.project_count),
  status: statusSchema.parse(row.status),
  userId: row.user_id,
});

const mapRun = (
  row: LibraryExportRunRow,
  checkpoints: LibraryExportCheckpointRow[]
): LibraryExportRunRecord => ({
  ...(row.archive_bytes === null ? {} : { archiveBytes: toSafeNumber(row.archive_bytes) }),
  ...(row.archive_sha256 ? { archiveSha256: row.archive_sha256 } : {}),
  bytesWritten: toSafeNumber(row.bytes_written),
  checkpoints: checkpoints.map(mapCheckpoint),
  correlationId: row.correlation_id,
  ...(row.current_project_id ? { currentProjectId: row.current_project_id } : {}),
  ...(row.error_code ? { errorCode: row.error_code } : {}),
  ...(row.error_detail ? { errorDetail: row.error_detail } : {}),
  ...(row.error_phase ? { errorPhase: phaseSchema.parse(row.error_phase) } : {}),
  expectedProjects: projectEntrySchema.array().parse(row.expected_projects),
  folders: folderSchema.array().parse(row.folders),
  id: row.id,
  phase: phaseSchema.parse(row.phase),
  placements: placementSchema.array().parse(row.placements),
  status: statusSchema.parse(row.status),
  userId: row.user_id,
});

export class PostgresLibraryExportRunStore implements LibraryExportRunStore {
  private readonly sql: Sql;

  constructor(databaseUrl = process.env.DATABASE_URL?.trim(), sqlClient?: Sql) {
    if (!databaseUrl && !sqlClient)
      throw new Error('DATABASE_URL is required for library exports.');
    this.sql = sqlClient ?? postgres(databaseUrl as string);
  }

  async createRun(
    input: Omit<LibraryExportRunRecord, 'checkpoints'>
  ): Promise<LibraryExportRunRecord> {
    const rows = await this.sql<LibraryExportRunRow[]>`
      insert into public.library_export_runs (
        id, user_id, correlation_id, status, phase, expected_projects, folders, placements,
        current_project_id, bytes_written
      ) values (
        ${input.id}, ${input.userId}, ${input.correlationId}, ${input.status}, ${input.phase},
        ${this.sql.json(toPostgresJson(input.expectedProjects))},
        ${this.sql.json(toPostgresJson(input.folders))},
        ${this.sql.json(toPostgresJson(input.placements))},
        ${input.currentProjectId ?? null}, ${input.bytesWritten}
      )
      on conflict (user_id) where status not in ('cancelled', 'downloaded') do nothing
      returning *
    `;
    if (rows[0]) return this.loadRunWithCheckpoints(rows[0]);
    const existingRun = await this.findUndeliveredRun(input.userId);
    if (!existingRun) throw new Error('Concurrent library export run was not found.');
    return existingRun;
  }

  async authorizeDownload(userId: string, runId: string, tokenSha256: string): Promise<boolean> {
    const rows = await this.sql<Array<{ id: string }>>`
      update public.library_export_runs
      set download_token_sha256 = ${tokenSha256}, updated_at = clock_timestamp()
      where id = ${runId} and user_id = ${userId} and status = 'completed'
      returning id
    `;
    return Boolean(rows[0]);
  }

  async claimDownload(runId: string, tokenSha256: string): Promise<LibraryExportRunRecord | null> {
    const rows = await this.sql<LibraryExportRunRow[]>`
      update public.library_export_runs
      set download_token_sha256 = null, updated_at = clock_timestamp()
      where id = ${runId} and status = 'completed' and download_token_sha256 = ${tokenSha256}
      returning *
    `;
    return rows[0] ? this.loadRunWithCheckpoints(rows[0]) : null;
  }

  async findUndeliveredRun(userId: string): Promise<LibraryExportRunRecord | null> {
    const rows = await this.sql<LibraryExportRunRow[]>`
      select * from public.library_export_runs
      where user_id = ${userId} and status not in ('cancelled', 'downloaded')
      order by created_at desc
      limit 1
    `;
    return rows[0] ? this.loadRunWithCheckpoints(rows[0]) : null;
  }

  async getRun(userId: string, runId: string): Promise<LibraryExportRunRecord | null> {
    const rows = await this.sql<LibraryExportRunRow[]>`
      select * from public.library_export_runs where user_id = ${userId} and id = ${runId}
    `;
    return rows[0] ? this.loadRunWithCheckpoints(rows[0]) : null;
  }

  async getRunProgress(
    userId: string,
    runId: string
  ): Promise<LibraryExportRunProgressRecord | null> {
    const rows = await this.sql<LibraryExportRunProgressRow[]>`
      select
        runs.id,
        runs.user_id,
        runs.correlation_id,
        runs.status,
        runs.phase,
        runs.current_project_id,
        runs.bytes_written,
        runs.archive_bytes,
        runs.error_code,
        runs.error_phase,
        jsonb_array_length(runs.expected_projects) as project_count,
        count(checkpoints.project_id) as completed_project_count
      from public.library_export_runs as runs
      left join public.library_export_project_checkpoints as checkpoints
        on checkpoints.run_id = runs.id
      where runs.user_id = ${userId} and runs.id = ${runId}
      group by runs.id
    `;
    return rows[0] ? mapRunProgress(rows[0]) : null;
  }

  async listPendingCleanupRunIds(): Promise<string[]> {
    const rows = await this.sql<Array<{ id: string }>>`
      select id from public.library_export_runs
      where status in ('cancelled', 'downloaded') and cleanup_completed_at is null
      order by updated_at, id
    `;
    return rows.map(row => row.id);
  }

  async listRunningRuns(): Promise<LibraryExportRunRecord[]> {
    const rows = await this.sql<LibraryExportRunRow[]>`
      select * from public.library_export_runs where status = 'running' order by created_at, id
    `;
    return Promise.all(rows.map(row => this.loadRunWithCheckpoints(row)));
  }

  async markRunning(
    runId: string,
    phase: LibraryExportPhase,
    currentProjectId?: string
  ): Promise<void> {
    await this.sql`
      update public.library_export_runs
      set status = 'running', phase = ${phase}, current_project_id = ${currentProjectId ?? null},
          updated_at = clock_timestamp()
      where id = ${runId} and status <> 'downloaded'
    `;
  }

  async checkpointProject(
    runId: string,
    checkpoint: LibraryExportProjectCheckpoint
  ): Promise<void> {
    await this.sql.begin(async sql => {
      const runRows = await sql<Array<{ user_id: string }>>`
        select user_id from public.library_export_runs where id = ${runId} for update
      `;
      const run = runRows[0];
      if (!run) throw new Error('Library export run not found.');
      await sql`
        insert into public.library_export_project_checkpoints (
          run_id, user_id, project_id, project_index, project_incarnation_id, project_revision,
          archive_path, archive_bytes, archive_sha256
        ) values (
          ${runId}, ${run.user_id}, ${checkpoint.projectId}, ${checkpoint.projectIndex},
          ${checkpoint.projectIncarnationId ?? null}, ${checkpoint.projectRevision ?? null},
          ${checkpoint.archivePath},
          ${checkpoint.archiveBytes}, ${checkpoint.archiveSha256}
        )
        on conflict (run_id, project_id) do update set
          project_index = excluded.project_index,
          project_incarnation_id = excluded.project_incarnation_id,
          project_revision = excluded.project_revision,
          archive_path = excluded.archive_path,
          archive_bytes = excluded.archive_bytes,
          archive_sha256 = excluded.archive_sha256,
          completed_at = clock_timestamp()
      `;
      await sql`
        update public.library_export_runs
        set bytes_written = (
              select coalesce(sum(archive_bytes), 0)
              from public.library_export_project_checkpoints
              where run_id = ${runId}
            ),
            updated_at = clock_timestamp()
        where id = ${runId}
      `;
    });
  }

  async markCompleted(runId: string, archive: { bytes: number; sha256: string }): Promise<boolean> {
    return this.sql.begin(async sql => {
      const runRows = await sql<
        Array<{ expected_projects: unknown; phase: string; status: string; user_id: string }>
      >`
        select user_id, status, phase, expected_projects
        from public.library_export_runs
        where id = ${runId}
      `;
      const run = runRows[0];
      if (!run || run.status !== 'running' || run.phase !== 'integrity-check') return false;

      const expectedProjects = projectEntrySchema.array().parse(run.expected_projects);
      if (
        expectedProjects.some(
          project => project.incarnationId === undefined || project.revision === undefined
        )
      ) {
        return false;
      }

      const projectIds = expectedProjects.map(project => project.id);
      const projectRows = await sql<
        Array<{ id: string; incarnation_id: string; revision: number | string }>
      >`
        select id, incarnation_id, revision
        from public.projects
        where user_id = ${run.user_id} and id = any(${projectIds}::text[])
        order by id
        for share
      `;
      const projectById = new Map(projectRows.map(project => [project.id, project]));
      const projectChanged = expectedProjects.some(expectedProject => {
        const project = projectById.get(expectedProject.id);
        return (
          !project ||
          project.incarnation_id !== expectedProject.incarnationId ||
          Number(project.revision) !== expectedProject.revision
        );
      });
      if (projectChanged || projectRows.length !== expectedProjects.length) return false;

      const rows = await sql<Array<{ id: string }>>`
        update public.library_export_runs
        set status = 'completed', phase = 'ready', current_project_id = null,
            archive_bytes = ${archive.bytes}, archive_sha256 = ${archive.sha256},
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = ${runId} and status = 'running' and phase = 'integrity-check'
        returning id
      `;
      return Boolean(rows[0]);
    });
  }

  async markCancelled(
    runId: string,
    error: { code: string; detail: string; phase: LibraryExportPhase }
  ): Promise<void> {
    await this.sql`
      update public.library_export_runs
      set status = 'cancelled', phase = 'failed', error_code = ${error.code},
          error_phase = ${error.phase}, error_detail = ${error.detail},
          download_token_sha256 = null,
          updated_at = clock_timestamp()
      where id = ${runId} and status not in ('cancelled', 'downloaded')
    `;
  }

  async markDownloaded(runId: string): Promise<void> {
    await this.sql`
      update public.library_export_runs
      set status = 'downloaded', download_token_sha256 = null,
          downloaded_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = ${runId} and status = 'completed'
    `;
  }

  async markCleanupCompleted(runId: string): Promise<void> {
    await this.sql`
      update public.library_export_runs
      set cleanup_completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = ${runId} and status in ('cancelled', 'downloaded')
    `;
  }

  async markFailed(
    runId: string,
    error: { code: string; detail: string; phase: LibraryExportPhase }
  ): Promise<void> {
    await this.sql`
      update public.library_export_runs
      set status = 'failed', phase = 'failed', error_code = ${error.code},
          error_phase = ${error.phase}, error_detail = ${error.detail},
          download_token_sha256 = null,
          updated_at = clock_timestamp()
      where id = ${runId} and status <> 'downloaded'
    `;
  }

  private async loadRunWithCheckpoints(row: LibraryExportRunRow): Promise<LibraryExportRunRecord> {
    const checkpoints = await this.sql<LibraryExportCheckpointRow[]>`
      select project_id, project_index, project_incarnation_id, project_revision,
             archive_path, archive_bytes, archive_sha256
      from public.library_export_project_checkpoints
      where run_id = ${row.id}
      order by project_index
    `;
    return mapRun(row, checkpoints);
  }
}
