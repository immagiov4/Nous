import { createHash } from 'node:crypto';
import postgres from 'postgres';

type PostgresSql = ReturnType<typeof postgres>;

const RATE_LIMIT_MAX_REPORTS = 5;
const RATE_LIMIT_WINDOW_HOURS = 1;
const DUPLICATE_WINDOW_HOURS = 24;
const MAX_DELIVERY_ATTEMPTS = 8;
const STALE_DELIVERY_MINUTES = 10;

export type FeedbackCategory = 'bug' | 'enhancement' | 'other';
export type FeedbackStatus = 'failed' | 'pending' | 'processing' | 'submitted';
export type FeedbackSource = 'app' | 'github';
export type GithubIssueState = 'closed' | 'missing' | 'open';

export interface GithubIssueSnapshot {
  body: string;
  createdAt: string;
  feedbackId?: string;
  labels: string[];
  number: number;
  state: GithubIssueState;
  title: string;
  updatedAt: string;
  url: string;
}

export interface FeedbackConsoleEntry {
  level: 'debug' | 'error' | 'info' | 'warn';
  message: string;
  timestamp?: string;
}

export interface FeedbackDiagnostics {
  appVersion?: string;
  consoleEntries?: FeedbackConsoleEntry[];
  correlationIds?: string[];
  pageUrl?: string;
  requestId?: string;
  userAgent?: string;
}

export interface FeedbackScreenshot {
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/webp';
}

export interface NewFeedbackReport {
  category: FeedbackCategory;
  clientRequestId?: string;
  contentHash: string;
  description: string;
  diagnostics: FeedbackDiagnostics;
  reporterEmail?: string;
  screenshot?: FeedbackScreenshot;
  title?: string;
  userId: string;
}

export interface StoredFeedbackReport {
  attemptCount: number;
  category: FeedbackCategory;
  createdAt: string;
  description: string;
  diagnostics: FeedbackDiagnostics;
  githubIssueNumber?: number;
  githubIssueState?: GithubIssueState;
  githubIssueUrl?: string;
  githubLabels: string[];
  hasScreenshot: boolean;
  id: string;
  reporterEmail?: string;
  source: FeedbackSource;
  status: FeedbackStatus;
  title?: string;
  updatedAt: string;
  userId?: string;
}

export interface FeedbackReportPage {
  reports: StoredFeedbackReport[];
  total: number;
}

interface FeedbackReportRow {
  attempt_count: number;
  category: FeedbackCategory;
  created_at: Date | string;
  description: string;
  diagnostics: FeedbackDiagnostics;
  github_issue_number: number | null;
  github_issue_state: GithubIssueState | null;
  github_issue_title: string | null;
  github_issue_body: string | null;
  github_issue_url: string | null;
  github_labels: string[];
  id: string;
  reporter_email: string | null;
  screenshot_byte_size: number | null;
  source: FeedbackSource;
  status: FeedbackStatus;
  title: string | null;
  updated_at: Date | string;
  user_id: string | null;
}

interface FeedbackScreenshotRow {
  data: Uint8Array;
  mime_type: 'image/jpeg' | 'image/webp';
}

interface CountRow {
  count: number | string;
}

export class FeedbackRateLimitError extends Error {
  constructor() {
    super('Feedback submission rate limit exceeded.');
  }
}

const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const mapFeedbackReport = (row: FeedbackReportRow): StoredFeedbackReport => ({
  attemptCount: Number(row.attempt_count),
  category: row.category,
  createdAt: toIsoString(row.created_at),
  description: row.github_issue_body ?? row.description,
  diagnostics: row.diagnostics,
  ...(row.github_issue_number === null
    ? {}
    : { githubIssueNumber: Number(row.github_issue_number) }),
  ...(row.github_issue_state ? { githubIssueState: row.github_issue_state } : {}),
  ...(row.github_issue_url ? { githubIssueUrl: row.github_issue_url } : {}),
  githubLabels: row.github_labels,
  hasScreenshot: Boolean(row.screenshot_byte_size),
  id: row.id,
  ...(row.reporter_email ? { reporterEmail: row.reporter_email } : {}),
  source: row.source,
  status: row.status,
  ...(row.github_issue_title || row.title
    ? { title: row.github_issue_title ?? row.title ?? undefined }
    : {}),
  updatedAt: toIsoString(row.updated_at),
  ...(row.user_id ? { userId: row.user_id } : {}),
});

const toPostgresJson = (value: unknown): postgres.JSONValue => value as postgres.JSONValue;

const FEEDBACK_REPORT_COLUMNS = `
  id, user_id, reporter_email, category, title, description, diagnostics,
  status, attempt_count, github_issue_number, github_issue_url,
  github_issue_state, github_issue_title, github_issue_body, github_labels, source,
  screenshot_byte_size, created_at, updated_at
`;

const hashGithubIssue = (issue: GithubIssueSnapshot): string =>
  createHash('sha256').update(`${issue.number}\0${issue.title}\0${issue.body}`).digest('hex');

export class PostgresFeedbackStore {
  private readonly sql: PostgresSql;

  constructor(databaseUrl = process.env.DATABASE_URL?.trim(), sqlClient?: PostgresSql) {
    if (!databaseUrl && !sqlClient) {
      throw new Error('DATABASE_URL is required to store feedback reports.');
    }

    this.sql = sqlClient ?? postgres(databaseUrl as string, { max: 4 });
  }

  async create(
    input: NewFeedbackReport
  ): Promise<{ created: boolean; report: StoredFeedbackReport }> {
    return this.sql.begin(async sql => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`;

      if (input.clientRequestId) {
        const idempotentRows = await sql<FeedbackReportRow[]>`
          select ${this.sql.unsafe(FEEDBACK_REPORT_COLUMNS)}
          from public.feedback_reports
          where user_id = ${input.userId}::uuid
            and client_request_id = ${input.clientRequestId}
          limit 1
        `;
        if (idempotentRows[0]) {
          return { created: false, report: mapFeedbackReport(idempotentRows[0]) };
        }
      }

      const duplicateRows = await sql<FeedbackReportRow[]>`
        select ${this.sql.unsafe(FEEDBACK_REPORT_COLUMNS)}
        from public.feedback_reports
        where user_id = ${input.userId}::uuid
          and content_hash = ${input.contentHash}
          and created_at >= now() - (${DUPLICATE_WINDOW_HOURS} * interval '1 hour')
        order by created_at desc
        limit 1
      `;
      if (duplicateRows[0]) {
        return { created: false, report: mapFeedbackReport(duplicateRows[0]) };
      }

      const countRows = await sql<CountRow[]>`
        select count(*)::integer as count
        from public.feedback_reports
        where user_id = ${input.userId}::uuid
          and created_at >= now() - (${RATE_LIMIT_WINDOW_HOURS} * interval '1 hour')
      `;
      if (Number(countRows[0]?.count ?? 0) >= RATE_LIMIT_MAX_REPORTS) {
        throw new FeedbackRateLimitError();
      }

      const screenshot = input.screenshot;
      const rows = await sql<FeedbackReportRow[]>`
        insert into public.feedback_reports (
          user_id,
          reporter_email,
          category,
          title,
          description,
          diagnostics,
          content_hash,
          client_request_id,
          screenshot_mime_type,
          screenshot_byte_size,
          screenshot_data
        ) values (
          ${input.userId}::uuid,
          ${input.reporterEmail ?? null},
          ${input.category},
          ${input.title ?? null},
          ${input.description},
          ${sql.json(toPostgresJson(input.diagnostics))},
          ${input.contentHash},
          ${input.clientRequestId ?? null},
          ${screenshot?.mimeType ?? null},
          ${screenshot?.bytes.byteLength ?? null},
          ${screenshot?.bytes ?? null}
        )
        returning ${sql.unsafe(FEEDBACK_REPORT_COLUMNS)}
      `;
      const report = rows[0];
      if (!report) {
        throw new Error('Feedback report insert returned no record.');
      }
      return { created: true, report: mapFeedbackReport(report) };
    });
  }

  async claimForDelivery(id?: string): Promise<StoredFeedbackReport | null> {
    const rows = await this.sql<FeedbackReportRow[]>`
      update public.feedback_reports
      set status = 'processing',
          attempt_count = attempt_count + 1,
          updated_at = now()
      where id = (
        select id
        from public.feedback_reports
        where (${id ?? null}::uuid is null or id = ${id ?? null}::uuid)
          and (
            (status = 'pending' and next_attempt_at <= now())
            or (status = 'processing' and updated_at < now() - (${STALE_DELIVERY_MINUTES} * interval '1 minute'))
          )
        order by next_attempt_at asc, created_at asc
        for update skip locked
        limit 1
      )
      returning ${this.sql.unsafe(FEEDBACK_REPORT_COLUMNS)}
    `;
    return rows[0] ? mapFeedbackReport(rows[0]) : null;
  }

  async markSubmitted(id: string, issueNumber: number, issueUrl: string): Promise<void> {
    await this.sql`
      update public.feedback_reports
      set status = 'submitted',
          github_issue_number = ${issueNumber},
          github_issue_url = ${issueUrl},
          github_issue_state = case
            when github_issue_number = ${issueNumber} then coalesce(github_issue_state, 'open')
            else 'open'
          end,
          last_error_code = null,
          submitted_at = now(),
          updated_at = now()
      where id = ${id}::uuid
    `;
  }

  async upsertGithubIssues(issues: GithubIssueSnapshot[]): Promise<number> {
    const payload = issues.map(issue => ({
      category: issue.labels.some(label => label.toLowerCase() === 'bug')
        ? 'bug'
        : issue.labels.some(label => label.toLowerCase() === 'enhancement')
          ? 'enhancement'
          : 'other',
      content_hash: hashGithubIssue(issue),
      created_at: issue.createdAt,
      feedback_id: issue.feedbackId ?? null,
      github_issue_body: issue.body,
      github_issue_number: issue.number,
      github_issue_state: issue.state,
      github_issue_title: issue.title,
      github_issue_url: issue.url,
      github_labels: issue.labels,
      updated_at: issue.updatedAt,
    }));

    await this.sql.begin(async sql => {
      const incomingIssues = sql.json(toPostgresJson(payload));
      await sql`
        with incoming as (
          select *
          from jsonb_to_recordset(${incomingIssues}::jsonb) as issue(
            category text,
            content_hash text,
            created_at timestamptz,
            feedback_id uuid,
            github_issue_body text,
            github_issue_number bigint,
            github_issue_state text,
            github_issue_title text,
            github_issue_url text,
            github_labels jsonb,
            updated_at timestamptz
          )
        )
        update public.feedback_reports as report
        set category = case when incoming.category = 'other' then report.category else incoming.category end,
            status = 'submitted',
            github_issue_number = incoming.github_issue_number,
            github_issue_url = incoming.github_issue_url,
            github_issue_state = incoming.github_issue_state,
            github_issue_title = incoming.github_issue_title,
            github_issue_body = incoming.github_issue_body,
            github_labels = incoming.github_labels,
            github_updated_at = incoming.updated_at,
            github_missing_sync_count = 0,
            submitted_at = coalesce(report.submitted_at, now()),
            updated_at = now()
        from incoming
        where incoming.feedback_id is not null and report.id = incoming.feedback_id
      `;

      await sql`
        with incoming as (
          select *
          from jsonb_to_recordset(${incomingIssues}::jsonb) as issue(
            category text,
            content_hash text,
            created_at timestamptz,
            feedback_id uuid,
            github_issue_body text,
            github_issue_number bigint,
            github_issue_state text,
            github_issue_title text,
            github_issue_url text,
            github_labels jsonb,
            updated_at timestamptz
          )
        )
        insert into public.feedback_reports (
          category,
          title,
          description,
          diagnostics,
          content_hash,
          status,
          github_issue_number,
          github_issue_url,
          github_issue_state,
          github_issue_title,
          github_issue_body,
          github_labels,
          github_updated_at,
          source,
          submitted_at,
          created_at,
          updated_at
        )
        select
          category,
          left(github_issue_title, 160),
          left(coalesce(nullif(github_issue_body, ''), 'Issue GitHub #' || github_issue_number), 5000),
          '{}'::jsonb,
          content_hash,
          'submitted',
          github_issue_number,
          github_issue_url,
          github_issue_state,
          github_issue_title,
          github_issue_body,
          github_labels,
          updated_at,
          'github',
          now(),
          created_at,
          now()
        from incoming
        on conflict (github_issue_number) where github_issue_number is not null do update
        set category = case
              when feedback_reports.source = 'app' and excluded.category = 'other'
                then feedback_reports.category
              else excluded.category
            end,
            status = 'submitted',
            github_issue_url = excluded.github_issue_url,
            github_issue_state = excluded.github_issue_state,
            github_issue_title = excluded.github_issue_title,
            github_issue_body = excluded.github_issue_body,
            github_labels = excluded.github_labels,
            github_updated_at = excluded.github_updated_at,
            github_missing_sync_count = 0,
            updated_at = now()
      `;

      const synchronizedIssueNumbers = issues.map(issue => issue.number);
      await sql`
        update public.feedback_reports
        set github_issue_state = 'missing',
            github_missing_sync_count = github_missing_sync_count + 1,
            updated_at = now()
        where source = 'app'
          and github_issue_number is not null
          and not (github_issue_number = any(${synchronizedIssueNumbers}::bigint[]))
      `;
      await sql`
        update public.feedback_reports
        set github_issue_state = 'missing',
            github_missing_sync_count = github_missing_sync_count + 1,
            updated_at = now()
        where source = 'github'
          and github_issue_number is not null
          and not (github_issue_number = any(${synchronizedIssueNumbers}::bigint[]))
      `;
      await sql`
        delete from public.feedback_reports
        where source = 'github'
          and github_missing_sync_count >= 2
      `;
    });

    return issues.length;
  }

  async markDeliveryFailed(id: string, errorCode: string, retryAt: Date): Promise<void> {
    await this.sql`
      update public.feedback_reports
      set status = case when attempt_count >= ${MAX_DELIVERY_ATTEMPTS} then 'failed' else 'pending' end,
          last_error_code = ${errorCode},
          next_attempt_at = ${retryAt},
          updated_at = now()
      where id = ${id}::uuid
    `;
  }

  async list(page: number, pageSize: number): Promise<FeedbackReportPage> {
    const offset = (page - 1) * pageSize;
    const [rows, countRows] = await Promise.all([
      this.sql<FeedbackReportRow[]>`
        select ${this.sql.unsafe(FEEDBACK_REPORT_COLUMNS)}
        from public.feedback_reports
        order by created_at desc, id desc
        limit ${pageSize}
        offset ${offset}
      `,
      this.sql<CountRow[]>`select count(*)::integer as count from public.feedback_reports`,
    ]);
    return {
      reports: rows.map(mapFeedbackReport),
      total: Number(countRows[0]?.count ?? 0),
    };
  }

  async getScreenshot(id: string): Promise<FeedbackScreenshot | null> {
    const rows = await this.sql<FeedbackScreenshotRow[]>`
      select screenshot_mime_type as mime_type, screenshot_data as data
      from public.feedback_reports
      where id = ${id}::uuid and screenshot_data is not null
      limit 1
    `;
    const row = rows[0];
    return row ? { bytes: Buffer.from(row.data), mimeType: row.mime_type } : null;
  }

  async retry(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update public.feedback_reports
      set status = 'pending',
          attempt_count = 0,
          next_attempt_at = now(),
          last_error_code = null,
          updated_at = now()
      where id = ${id}::uuid and status = 'failed'
      returning id
    `;
    return Boolean(rows[0]);
  }
}
