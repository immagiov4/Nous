import type { GenerationJobStage, LessonGenerationJobStage } from '@shared/generationJobContract';
import postgres, { type Sql } from 'postgres';
import type {
  EnqueueGenerationJobInput,
  GenerationJob,
  GenerationJobKind,
  GenerationJobStatus,
  GenerationJobStore,
} from '../services/generationJobs.js';

interface GenerationJobRow {
  attempt_count: number;
  completed_at: Date | string | null;
  created_at: Date | string;
  dedupe_key: string;
  error_code: string | null;
  id: string;
  kind: GenerationJobKind;
  payload: unknown;
  project_id: string;
  result: unknown;
  stage: GenerationJobStage;
  started_at: Date | string | null;
  status: GenerationJobStatus;
  updated_at: Date | string;
  user_id: string;
}

const TERMINAL_RETENTION_INTERVAL = '7 days';

const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const mapJob = (row: GenerationJobRow): GenerationJob => ({
  attemptCount: Number(row.attempt_count),
  ...(row.completed_at ? { completedAt: toIsoString(row.completed_at) } : {}),
  createdAt: toIsoString(row.created_at),
  dedupeKey: row.dedupe_key,
  ...(row.error_code ? { errorCode: row.error_code } : {}),
  id: row.id,
  kind: row.kind,
  payload: row.payload,
  projectId: row.project_id,
  ...(row.result === null ? {} : { result: row.result }),
  stage: row.stage,
  ...(row.started_at ? { startedAt: toIsoString(row.started_at) } : {}),
  status: row.status,
  updatedAt: toIsoString(row.updated_at),
  userId: row.user_id,
});

export class PostgresGenerationJobStore implements GenerationJobStore {
  private readonly sql: Sql;

  constructor(databaseUrl = process.env.DATABASE_URL, sqlClient?: Sql) {
    if (!databaseUrl && !sqlClient) {
      throw new Error('DATABASE_URL is required for generation job storage.');
    }
    this.sql = sqlClient ?? postgres(databaseUrl as string, { max: 10 });
  }

  async enqueue(
    input: EnqueueGenerationJobInput
  ): Promise<{ created: boolean; job: GenerationJob }> {
    return this.sql.begin(async sql => {
      const reusable = await sql<GenerationJobRow[]>`
        select *
        from public.generation_jobs
        where user_id = ${input.userId}
          and dedupe_key = ${input.dedupeKey}
          and status in ('queued', 'running', 'completed')
        order by created_at desc
        limit 1
      `;
      if (reusable[0]) return { created: false, job: mapJob(reusable[0]) };

      const inserted = await sql<GenerationJobRow[]>`
        insert into public.generation_jobs (
          id, user_id, project_id, kind, dedupe_key, payload
        ) values (
          ${input.id}, ${input.userId}, ${input.projectId}, ${input.kind},
          ${input.dedupeKey}, ${sql.json(input.payload as postgres.JSONValue)}
        )
        on conflict do nothing
        returning *
      `;
      if (inserted[0]) return { created: true, job: mapJob(inserted[0]) };

      const existing = await sql<GenerationJobRow[]>`
        select *
        from public.generation_jobs
        where user_id = ${input.userId}
          and status in ('queued', 'running')
          and (
            dedupe_key = ${input.dedupeKey}
            or (${input.kind} = 'lesson' and kind = 'lesson' and project_id = ${input.projectId})
          )
        order by created_at
        limit 1
      `;
      if (!existing[0]) throw new Error('Active generation job conflict could not be resolved.');
      return { created: false, job: mapJob(existing[0]) };
    });
  }

  async getForUser(userId: string, id: string): Promise<GenerationJob | null> {
    const rows = await this.sql<GenerationJobRow[]>`
      select * from public.generation_jobs where user_id = ${userId} and id = ${id} limit 1
    `;
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async getLatestLessonForUser(
    userId: string,
    projectId: string,
    sectionId: string
  ): Promise<GenerationJob | null> {
    const rows = await this.sql<GenerationJobRow[]>`
      select *
      from public.generation_jobs
      where user_id = ${userId}
        and project_id = ${projectId}
        and kind = 'lesson'
        and payload ->> 'sectionId' = ${sectionId}
      order by created_at desc
      limit 1
    `;
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async claimNext(): Promise<GenerationJob | null> {
    return this.sql.begin(async sql => {
      const rows = await sql<GenerationJobRow[]>`
        select *
        from public.generation_jobs
        where status = 'queued'
        order by created_at
        for update skip locked
        limit 1
      `;
      const job = rows[0];
      if (!job) return null;
      const claimed = await sql<GenerationJobRow[]>`
        update public.generation_jobs
        set status = 'running', stage = 'running', attempt_count = attempt_count + 1,
            started_at = now(), updated_at = now()
        where id = ${job.id}
        returning *
      `;
      return claimed[0] ? mapJob(claimed[0]) : null;
    });
  }

  async complete(id: string, result: unknown): Promise<void> {
    await this.sql`
      update public.generation_jobs
      set status = 'completed', stage = 'completed', result = ${this.sql.json(result as postgres.JSONValue)},
          error_code = null, completed_at = now(), updated_at = now(),
          expires_at = now() + ${TERMINAL_RETENTION_INTERVAL}::interval
      where id = ${id} and status = 'running'
    `;
  }

  async fail(id: string, errorCode: string): Promise<void> {
    await this.sql`
      update public.generation_jobs
      set status = 'failed', stage = 'failed', error_code = ${errorCode},
          completed_at = now(), updated_at = now(),
          expires_at = now() + ${TERMINAL_RETENTION_INTERVAL}::interval
      where id = ${id} and status = 'running'
    `;
  }

  async requeue(id: string): Promise<void> {
    await this.sql`
      update public.generation_jobs
      set status = 'queued', stage = 'queued', started_at = null, updated_at = now()
      where id = ${id} and status = 'running' and attempt_count < 2
    `;
  }

  async updateStage(id: string, stage: LessonGenerationJobStage): Promise<void> {
    await this.sql`
      update public.generation_jobs
      set stage = ${stage}, updated_at = now()
      where id = ${id} and status = 'running'
    `;
  }

  async recoverInterrupted(): Promise<void> {
    await this.sql.begin(async sql => {
      await sql`
        update public.generation_jobs
        set status = 'queued', stage = 'queued', started_at = null, updated_at = now()
        where status = 'running' and attempt_count < 2
      `;
      await sql`
        update public.generation_jobs
        set status = 'failed', stage = 'failed', error_code = 'backend_restarted',
            completed_at = now(), updated_at = now(),
            expires_at = now() + ${TERMINAL_RETENTION_INTERVAL}::interval
        where status = 'running'
      `;
    });
  }
}
