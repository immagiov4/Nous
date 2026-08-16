import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { queryProjectSourceReferences } from '../../../../scripts/project-source-storage-artifact.ts';
import { createApp } from '../../src/index.js';
import { PostgresProjectStore } from '../../src/projects/postgresProjectStore.js';
import { setProjectStoreForTesting } from '../../src/projects/projectStore.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import { setFeedbackServiceForTesting } from '../../src/services/feedbackService.js';
import { PostgresFeedbackStore } from '../../src/services/feedbackStore.js';
import { signSupabaseJwt } from '../helpers/auth.js';

const RUN_LOCAL_SUPABASE_TESTS = process.env.RUN_SUPABASE_LOCAL_TESTS === '1';
const describeLocalSupabase = RUN_LOCAL_SUPABASE_TESTS ? describe : describe.skip;

const LOCAL_SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const LOCAL_DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const LOCAL_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long';
const LOCAL_JWT_EXPIRY = 1_983_812_996;
const TEST_EMAIL_PREFIX = 'integration-nous-reader';
const TEST_PASSWORD = 'Integration-password-2026!';
const INVITE_PASSWORD = 'Integration-invite-2026!';
const RECOVERY_PASSWORD = 'Integration-recovery-2026!';
const MAGIC_LINK_TEST_EMAIL = process.env.SUPABASE_MAGIC_LINK_TEST_EMAIL?.trim();
const testMagicLinkSmtp = MAGIC_LINK_TEST_EMAIL ? test : test.skip;
const ORIGINAL_ENV = { ...process.env };

interface PersistedModelConfigProjection {
  artifact_visual_review_max_rounds: number;
  context_model: string;
  course_model: string;
  lesson_model: string;
}

const createApiKey = (role: 'anon' | 'service_role'): string =>
  signSupabaseJwt(
    {
      iss: 'supabase-demo',
      role,
      exp: LOCAL_JWT_EXPIRY,
    },
    LOCAL_JWT_SECRET
  );

const createBackendAdminToken = (): string =>
  signSupabaseJwt(
    {
      aud: 'authenticated',
      sub: '00000000-0000-4000-8000-00000000ad01',
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: `${LOCAL_SUPABASE_URL.replace(/\/$/, '')}/auth/v1`,
      app_metadata: {
        role: 'admin',
      },
    },
    LOCAL_JWT_SECRET
  );

const createSnapshot = (
  id: string,
  title: string,
  updatedAt = '2026-07-07T10:00:00.000Z'
): ProjectSnapshot => ({
  id,
  version: '4.1',
  sourceKind: 'document',
  learningPlan: {
    title,
    sections: [
      { id: 'lesson-1', title: 'Lezione 1', isCompleted: false },
      { id: 'lesson-2', title: 'Lezione 2', isCompleted: true },
    ],
  },
  source: null,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: null,
  createdAt: '2026-07-07T09:00:00.000Z',
  updatedAt,
  lastOpenedAt: updatedAt,
  documentIndex: {
    chunks: [{ id: 'chunk-1', text: 'contenuto indicizzato' }],
  },
});

const readJsonResponse = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
};

const readJwtPayload = (accessToken: string): Record<string, unknown> => {
  const encodedPayload = accessToken.split('.')[1] || '';
  return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
};

describeLocalSupabase('Supabase local integration', () => {
  const app = createApp();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || createApiKey('service_role');
  const anonKey = process.env.SUPABASE_ANON_KEY || serviceRoleKey;
  const sql = postgres(LOCAL_DATABASE_URL, { max: 2 });
  const store = new PostgresProjectStore(LOCAL_DATABASE_URL);
  const adminAuthorization = `Bearer ${createBackendAdminToken()}`;
  const createdEmails: string[] = [];

  const applyLocalSupabaseEnvironment = () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.DATABASE_URL = LOCAL_DATABASE_URL;
    process.env.SUPABASE_JWT_SECRET = LOCAL_JWT_SECRET;
    process.env.SUPABASE_URL = LOCAL_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
    delete process.env.GITHUB_FEEDBACK_REPOSITORY;
    delete process.env.GITHUB_FEEDBACK_TOKEN;
  };

  beforeAll(async () => {
    applyLocalSupabaseEnvironment();
    setProjectStoreForTesting(store);
    setFeedbackServiceForTesting(null);
    await sql`delete from public.feedback_reports where reporter_email like ${`${TEST_EMAIL_PREFIX}-%@nous.local`}`;
    await sql`delete from auth.users where email like ${`${TEST_EMAIL_PREFIX}-%@nous.local`}`;
  });

  beforeEach(() => {
    applyLocalSupabaseEnvironment();
  });

  afterAll(async () => {
    await sql`delete from public.feedback_reports where reporter_email like ${`${TEST_EMAIL_PREFIX}-%@nous.local`}`;
    if (createdEmails.length > 0) {
      await sql`delete from auth.users where email in ${sql(createdEmails)}`;
    }
    await store.close();
    setProjectStoreForTesting(null);
    setFeedbackServiceForTesting(null);
    await sql.end({ timeout: 5 });
    process.env = { ...ORIGINAL_ENV };
  });

  const createUser = async (suffix: string, explicitEmail?: string) => {
    const email = explicitEmail || `${TEST_EMAIL_PREFIX}-${suffix}-${Date.now()}@nous.local`;
    createdEmails.push(email);

    const response = await request(app)
      .post('/api/admin/users')
      .set('Authorization', adminAuthorization)
      .send({
        email,
        password: TEST_PASSWORD,
        role: 'user',
      });

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ email });
    return response.body.user as { id: string; email: string };
  };

  const login = async (email: string): Promise<string> => {
    const { body, response } = await requestPasswordGrant(email, TEST_PASSWORD);

    expect(response.status).toBe(200);
    expect(body.access_token).toEqual(expect.any(String));
    return body.access_token as string;
  };

  const requestPasswordGrant = async (email: string, password: string) => {
    const response = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
      }),
    });
    const body = await readJsonResponse<{ access_token?: string; error?: string }>(response);
    return { body, response };
  };

  const fetchProjectsViaPostgrest = async (accessToken: string) => {
    const response = await fetch(`${LOCAL_SUPABASE_URL}/rest/v1/projects?select=id,user_id,meta`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    return readJsonResponse<Array<{ id: string; user_id: string; meta: { title?: string } }>>(
      response
    );
  };

  test('authenticates through Supabase Auth and isolates projects through backend and RLS', async () => {
    const userA = await createUser('a');
    const userB = await createUser('b');
    const tokenA = await login(userA.email);
    const tokenB = await login(userB.email);

    const saveAResponse = await request(app)
      .put('/api/projects/projects/shared-course')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ snapshot: createSnapshot('shared-course', 'Corso utente A') });
    expect(saveAResponse.status).toBe(200);
    expect(saveAResponse.body.meta).toMatchObject({
      id: 'shared-course',
      title: 'Corso utente A',
      lessonCount: 2,
    });

    const saveBResponse = await request(app)
      .put('/api/projects/projects/shared-course')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ snapshot: createSnapshot('shared-course', 'Corso utente B') });
    expect(saveBResponse.status).toBe(200);

    const saveAOnlyResponse = await request(app)
      .put('/api/projects/projects/a-only-course')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ snapshot: createSnapshot('a-only-course', 'Solo utente A') });
    expect(saveAOnlyResponse.status).toBe(200);

    const listAResponse = await request(app)
      .get('/api/projects/projects')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(
      listAResponse.body.projects.map((project: { title: string }) => project.title).sort()
    ).toEqual(['Corso utente A', 'Solo utente A']);

    const loadAOnlyFromBResponse = await request(app)
      .get('/api/projects/projects/a-only-course')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(loadAOnlyFromBResponse.status).toBe(200);
    expect(loadAOnlyFromBResponse.body.project).toBeNull();

    const restRowsA = await fetchProjectsViaPostgrest(tokenA);
    expect(restRowsA.map(row => row.user_id)).toEqual([userA.id, userA.id]);
    expect(restRowsA.map(row => row.meta.title).sort()).toEqual([
      'Corso utente A',
      'Solo utente A',
    ]);

    const forbiddenInsertResponse = await fetch(`${LOCAL_SUPABASE_URL}/rest/v1/projects`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userB.id,
        id: 'rls-should-reject',
        meta: { id: 'rls-should-reject', title: 'Tentativo cross-tenant' },
        updated_at: '2026-07-07T10:00:00.000Z',
        last_opened_at: '2026-07-07T10:00:00.000Z',
      }),
    });
    expect(forbiddenInsertResponse.status).toBe(403);
  });

  test('keeps import diagnostics searchable after recreating the backend store', async () => {
    const user = await createUser('import-diagnostic');
    const accessToken = await login(user.email);
    const correlationId = randomUUID();
    const recordResponse = await request(app)
      .post('/api/projects/import-diagnostics')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        correlationId,
        code: 'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
        stage: 'project-import',
        fileBytes: 173_398_950,
        projectIndex: 2,
        projectCount: 11,
      });
    expect(recordResponse.status).toBe(204);

    const restartedStore = new PostgresProjectStore(LOCAL_DATABASE_URL);
    try {
      setProjectStoreForTesting(restartedStore);
      const lookupResponse = await request(createApp())
        .get(`/api/projects/import-diagnostics?correlationId=${correlationId}`)
        .set('Authorization', adminAuthorization);

      expect(lookupResponse.status).toBe(200);
      expect(lookupResponse.body.diagnostics).toMatchObject([
        {
          correlationId,
          code: 'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
          stage: 'project-import',
          fileBytes: 173_398_950,
          projectIndex: 2,
          projectCount: 11,
          userId: user.id,
        },
      ]);
    } finally {
      setProjectStoreForTesting(store);
      await restartedStore.close();
      await sql`delete from public.project_import_diagnostics where correlation_id = ${correlationId}`;
    }
  });

  test('persists valid archive entry paths in the source index', async () => {
    const user = await createUser('archive-entry-path');
    const projectId = `archive-entry-path-${Date.now()}`;
    const sourceHash = 'a'.repeat(64);

    try {
      await sql`
        insert into public.projects (user_id, id, meta, updated_at)
        values (
          ${user.id},
          ${projectId},
          ${sql.json({ id: projectId, title: 'Archive entry path' })},
          now()
        )
      `;
      await sql`
        insert into public.project_sources (
          user_id,
          project_id,
          source_id,
          source_hash,
          name,
          mime_type,
          byte_size,
          object_path,
          source_kind
        )
        values (
          ${user.id},
          ${projectId},
          'source-primary',
          ${sourceHash},
          'source.zip',
          'application/zip',
          1,
          ${`users/${user.id}/projects/${projectId}/source-primary/${sourceHash}/original`},
          'archive'
        )
      `;

      await sql`
        insert into public.project_source_entries (user_id, project_id, path, kind)
        values (${user.id}, ${projectId}, 'src', 'directory')
      `;

      const rows = await sql<Array<{ path: string }>>`
        select path
        from public.project_source_entries
        where user_id = ${user.id} and project_id = ${projectId}
      `;
      expect(rows).toEqual([{ path: 'src' }]);
    } finally {
      await sql`
        delete from public.projects
        where user_id = ${user.id} and id = ${projectId}
      `;
    }
  });

  test('persists project source bytes only in private Storage and serves them through the backend', async () => {
    const projectSourceBuckets = await sql<Array<{ id: string; is_public: boolean }>>`
      select id, public as is_public
      from storage.buckets
      where id = 'project-sources'
    `;
    expect(projectSourceBuckets).toEqual([{ id: 'project-sources', is_public: false }]);

    const user = await createUser('project-source-storage');
    const accessToken = await login(user.email);
    const projectId = `storage-course-${Date.now()}`;
    const sourceFiles = [
      {
        data: Buffer.from('%PDF-1.4\nintegration source').toString('base64'),
        mimeType: 'application/pdf',
        name: 'integration.pdf',
        sourceId: 'source-primary',
      },
      {
        data: Buffer.from('integration notes').toString('base64'),
        mimeType: 'text/plain',
        name: 'notes.txt',
        sourceId: 'source-notes',
      },
    ];
    const sourceDescriptors = sourceFiles.map((file, position) => ({
      file,
      hash: createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex'),
      id: file.sourceId,
      kind: position === 0 ? 'pdf' : 'text',
      name: file.name,
      outline: [],
      outlineOrigin: 'none',
      position,
      status: 'ready',
    }));
    const snapshot = {
      ...createSnapshot(projectId, 'Corso Storage'),
      source: {
        file: sourceFiles[0],
        kind: 'pdf',
        sources: sourceDescriptors,
      },
    } satisfies ProjectSnapshot;

    const saveProjectResponse = await request(app)
      .put(`/api/projects/projects/${projectId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ snapshot });
    expect(saveProjectResponse.status, JSON.stringify(saveProjectResponse.body)).toBe(200);

    const metadataRows = await sql<
      Array<{
        byte_size: string;
        object_path: string;
        source_hash: string;
      }>
    >`
      select byte_size, object_path, source_hash
      from public.project_sources
      where user_id = ${user.id} and project_id = ${projectId}
    `;
    expect(metadataRows).toHaveLength(1);
    expect(Number(metadataRows[0]?.byte_size)).toBe(
      Buffer.from(sourceFiles[0].data, 'base64').byteLength
    );
    expect(metadataRows[0]?.object_path).toMatch(
      /^users\/[0-9a-f-]+\/projects\/[0-9a-f]{64}\/source-primary\/[0-9a-f]{64}\/original$/u
    );

    const sourceFileRows = await sql<
      Array<{
        byte_size: string;
        object_path: string;
        position: number;
        source_id: string;
      }>
    >`
      select byte_size, object_path, position, source_id
      from public.project_source_files
      where user_id = ${user.id} and project_id = ${projectId}
      order by position
    `;
    expect(sourceFileRows.map(row => row.source_id)).toEqual(['source-primary', 'source-notes']);
    expect(sourceFileRows.map(row => row.position)).toEqual([0, 1]);

    const byteaColumns = await sql<Array<{ column_name: string }>>`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'project_sources'
        and column_name = 'data'
    `;
    expect(byteaColumns).toEqual([]);

    const snapshotRows = await sql<Array<{ snapshot: ProjectSnapshot }>>`
      select snapshot
      from public.project_snapshots
      where user_id = ${user.id} and id = ${projectId}
    `;
    expect(snapshotRows).toHaveLength(1);
    expect(snapshotRows[0]?.snapshot.source).toMatchObject({
      file: { data: '' },
      sources: [{ file: { data: '' } }, { file: { data: '' } }],
    });

    const backendSourceResponse = await request(app)
      .get(`/api/projects/projects/${projectId}/source`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(backendSourceResponse.status).toBe(200);
    expect(backendSourceResponse.body.source).toEqual({
      data: sourceFiles[0].data,
      mimeType: sourceFiles[0].mimeType,
      name: sourceFiles[0].name,
    });

    const backendSourcesResponse = await request(app)
      .get(`/api/projects/projects/${projectId}/sources`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(backendSourcesResponse.status).toBe(200);
    expect(
      backendSourcesResponse.body.sources.map(
        (storedSource: { file: { data: string } }) => storedSource.file.data
      )
    ).toEqual(sourceFiles.map(file => file.data));

    const backupReferences = await queryProjectSourceReferences(sql);
    const backupPaths = new Set(backupReferences.map(reference => reference.object_path));
    expect(sourceFileRows.every(row => backupPaths.has(row.object_path))).toBe(true);

    for (const row of sourceFileRows) {
      const directStorageResponse = await fetch(
        `${LOCAL_SUPABASE_URL}/storage/v1/object/project-sources/${row.object_path}`,
        {
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      expect([400, 401, 403, 404]).toContain(directStorageResponse.status);

      const serviceStorageResponse = await fetch(
        `${LOCAL_SUPABASE_URL}/storage/v1/object/project-sources/${row.object_path}`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        }
      );
      expect(serviceStorageResponse.status).toBe(200);
      expect(new Uint8Array(await serviceStorageResponse.arrayBuffer())).toEqual(
        new Uint8Array(Buffer.from(sourceFiles[row.position].data, 'base64'))
      );
    }

    const deleteResponse = await request(app)
      .delete(`/api/projects/projects/${projectId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(deleteResponse.status).toBe(200);

    for (const row of sourceFileRows) {
      const deletedStorageResponse = await fetch(
        `${LOCAL_SUPABASE_URL}/storage/v1/object/project-sources/${row.object_path}`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        }
      );
      expect([400, 404]).toContain(deletedStorageResponse.status);
    }
    const deletedObjectPaths = sourceFileRows.map(row => row.object_path);
    const remainingStorageRows = await sql<Array<{ name: string }>>`
      select name
      from storage.objects
      where bucket_id = 'project-sources' and name in ${sql(deletedObjectPaths)}
    `;
    expect(remainingStorageRows).toEqual([]);
  });

  test('reads the model config persisted in Supabase', async () => {
    const persistedRows = await sql<PersistedModelConfigProjection[]>`
      select artifact_visual_review_max_rounds, context_model, course_model, lesson_model
      from public.model_config
      where id = 'global'
    `;
    expect(persistedRows).toHaveLength(1);

    const configResponse = await request(app)
      .get('/api/admin/model-config')
      .set('Authorization', adminAuthorization);
    expect(configResponse.status).toBe(200);
    expect(configResponse.body.config).toMatchObject({
      artifactVisualReviewMaxRounds: persistedRows[0]?.artifact_visual_review_max_rounds,
      contextModel: persistedRows[0]?.context_model,
      courseModel: persistedRows[0]?.course_model,
      lessonModel: persistedRows[0]?.lesson_model,
    });

    const legacyColumns = await sql<Array<{ column_name: string }>>`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'model_config'
        and column_name in (
          'codex_drafting_model',
          'codex_structure_model',
          'codex_verification_model',
          'drafting_reasoning_effort',
          'structure_reasoning_effort',
          'verification_reasoning_effort'
        )
    `;
    expect(legacyColumns).toEqual([]);
  });

  test('persists authenticated feedback while keeping the inbox private through RLS', async () => {
    const user = await createUser('feedback');
    const accessToken = await login(user.email);
    const clientRequestId = `feedback-${Date.now()}`;

    const submitResponse = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        category: 'bug',
        clientRequestId,
        description: 'Il salvataggio non completa il corso.',
        diagnostics: {
          correlationIds: ['integration-job-1'],
          pageUrl: 'http://localhost:5173/course/private-course-id',
        },
      });

    expect(submitResponse.status).toBe(201);
    expect(submitResponse.body.feedback).toMatchObject({ status: 'pending' });
    const feedbackId = submitResponse.body.feedback.id as string;

    const rows = await sql<
      Array<{
        category: string;
        client_request_id: string;
        reporter_email: string;
        status: string;
        user_id: string;
      }>
    >`
      select category, client_request_id, reporter_email, status, user_id
      from public.feedback_reports
      where id = ${feedbackId}
    `;
    expect(rows[0]).toMatchObject({
      category: 'bug',
      client_request_id: clientRequestId,
      reporter_email: user.email,
      status: 'pending',
      user_id: user.id,
    });

    const directUserRead = await fetch(
      `${LOCAL_SUPABASE_URL}/rest/v1/feedback_reports?select=id&id=eq.${feedbackId}`,
      {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    expect([401, 403]).toContain(directUserRead.status);

    const githubIssueNumber = 900_000_000 + (Date.now() % 10_000_000);
    const feedbackStore = new PostgresFeedbackStore(LOCAL_DATABASE_URL);
    await feedbackStore.upsertGithubIssues([
      {
        body: 'Corpo autorevole aggiornato su GitHub.',
        createdAt: '2026-07-16T10:00:00.000Z',
        feedbackId,
        labels: ['bug', 'source:user-feedback'],
        number: githubIssueNumber,
        state: 'closed',
        title: 'Titolo autorevole GitHub',
        updatedAt: '2026-07-16T12:00:00.000Z',
        url: `https://github.com/example/nous-reader/issues/${githubIssueNumber}`,
      },
    ]);
    await expect(
      feedbackStore.markSubmitted(
        feedbackId,
        githubIssueNumber,
        `https://github.com/example/nous-reader/issues/${githubIssueNumber}`
      )
    ).resolves.toBeUndefined();
    const issueNumberRows = await sql<Array<{ count: number }>>`
      select count(*)::integer as count
      from public.feedback_reports
      where github_issue_number = ${githubIssueNumber}
    `;
    expect(issueNumberRows[0]?.count).toBe(1);

    const synchronizedRows = await sql<
      Array<{
        diagnostics: { correlationIds?: string[] };
        github_issue_state: string;
        github_issue_title: string;
        source: string;
      }>
    >`
      select diagnostics, github_issue_state, github_issue_title, source
      from public.feedback_reports
      where id = ${feedbackId}
    `;
    expect(synchronizedRows[0]).toMatchObject({
      diagnostics: { correlationIds: ['integration-job-1'] },
      github_issue_state: 'closed',
      github_issue_title: 'Titolo autorevole GitHub',
      source: 'app',
    });

    const adminListResponse = await request(app)
      .get('/api/feedback/admin?page=1&pageSize=10')
      .set('Authorization', adminAuthorization);
    expect(adminListResponse.status).toBe(200);
    expect(adminListResponse.body.reports).toContainEqual(
      expect.objectContaining({
        description: 'Corpo autorevole aggiornato su GitHub.',
        githubIssueState: 'closed',
        id: feedbackId,
        reporterEmail: user.email,
        title: 'Titolo autorevole GitHub',
      })
    );

    await feedbackStore.upsertGithubIssues([
      {
        body: 'Corpo autorevole senza etichetta categoria.',
        createdAt: '2026-07-16T10:00:00.000Z',
        feedbackId,
        labels: ['source:user-feedback'],
        number: githubIssueNumber,
        state: 'closed',
        title: 'Titolo senza etichetta categoria',
        updatedAt: '2026-07-16T12:05:00.000Z',
        url: `https://github.com/example/nous-reader/issues/${githubIssueNumber}`,
      },
    ]);
    const categoryRows = await sql<Array<{ category: string }>>`
      select category from public.feedback_reports where id = ${feedbackId}
    `;
    expect(categoryRows[0]?.category).toBe('bug');

    await feedbackStore.upsertGithubIssues([]);
    const missingIssueRows = await sql<
      Array<{
        description: string;
        diagnostics: { correlationIds?: string[] };
        github_issue_number: string | null;
        github_issue_state: string | null;
        status: string;
      }>
    >`
      select description, diagnostics, github_issue_number, github_issue_state, status
      from public.feedback_reports
      where id = ${feedbackId}
    `;
    expect(missingIssueRows[0]).toMatchObject({
      description: 'Il salvataggio non completa il corso.',
      diagnostics: { correlationIds: ['integration-job-1'] },
      github_issue_number: String(githubIssueNumber),
      github_issue_state: 'missing',
      status: 'submitted',
    });
  });

  test('imports direct GitHub issues idempotently and mirrors later closure', async () => {
    const githubIssueNumber = 910_000_000 + (Date.now() % 10_000_000);
    const feedbackStore = new PostgresFeedbackStore(LOCAL_DATABASE_URL);
    const issue = {
      body: 'Issue creata direttamente nel repository.',
      createdAt: '2026-07-16T10:00:00.000Z',
      labels: ['documentation'],
      number: githubIssueNumber,
      state: 'open' as const,
      title: 'Issue GitHub diretta',
      updatedAt: '2026-07-16T11:00:00.000Z',
      url: `https://github.com/example/nous-reader/issues/${githubIssueNumber}`,
    };

    try {
      await feedbackStore.upsertGithubIssues([issue]);
      await feedbackStore.upsertGithubIssues([
        {
          ...issue,
          state: 'closed',
          title: 'Issue GitHub diretta aggiornata',
          updatedAt: '2026-07-16T12:00:00.000Z',
        },
      ]);

      const rows = await sql<
        Array<{ category: string; github_issue_state: string; source: string; title: string }>
      >`
        select category, github_issue_state, source, github_issue_title as title
        from public.feedback_reports
        where github_issue_number = ${githubIssueNumber}
      `;
      expect(rows).toEqual([
        {
          category: 'other',
          github_issue_state: 'closed',
          source: 'github',
          title: 'Issue GitHub diretta aggiornata',
        },
      ]);

      await feedbackStore.upsertGithubIssues([]);
      await feedbackStore.upsertGithubIssues([]);
      const removedRows = await sql`
        select id from public.feedback_reports where github_issue_number = ${githubIssueNumber}
      `;
      expect(removedRows).toHaveLength(0);
    } finally {
      await sql`delete from public.feedback_reports where github_issue_number = ${githubIssueNumber}`;
    }
  });

  test('keeps signup closed and enforces server-owned invite setup through refreshed claims', async () => {
    const inviteEmail = `${TEST_EMAIL_PREFIX}-invite-${Date.now()}@nous.local`;
    const unknownEmail = `${TEST_EMAIL_PREFIX}-unknown-${Date.now()}@nous.local`;
    createdEmails.push(inviteEmail);
    const authHeaders = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    };

    const listResponse = await fetch(
      `${LOCAL_SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`,
      { headers: authHeaders }
    );
    expect(listResponse.status).toBe(200);
    expect(Array.isArray((await readJsonResponse<{ users?: unknown }>(listResponse)).users)).toBe(
      true
    );

    const createInvitedUserResponse = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        email: inviteEmail,
        email_confirm: true,
        app_metadata: { password_setup_required: true },
      }),
    });
    const invitedUser = await readJsonResponse<{ id?: string }>(createInvitedUserResponse);
    expect(createInvitedUserResponse.status).toBe(200);
    expect(invitedUser.id).toEqual(expect.any(String));

    const inviteLinkResponse = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ type: 'magiclink', email: inviteEmail }),
    });
    const inviteLink = await readJsonResponse<{
      action_link?: string;
      verification_type?: string;
    }>(inviteLinkResponse);
    expect(inviteLinkResponse.status).toBe(200);
    expect(inviteLink.verification_type).toBe('magiclink');
    expect(inviteLink.action_link).toEqual(expect.any(String));

    const inviteCallback = await fetch(inviteLink.action_link as string, { redirect: 'manual' });
    expect(inviteCallback.status).toBe(303);
    const inviteCallbackParams = new URLSearchParams(
      new URL(inviteCallback.headers.get('location') || '').hash.replace(/^#/, '')
    );
    expect(inviteCallbackParams.get('type')).toBe('magiclink');
    const inviteAccessToken = inviteCallbackParams.get('access_token');
    const inviteRefreshToken = inviteCallbackParams.get('refresh_token');
    expect(inviteAccessToken).toEqual(expect.any(String));
    expect(inviteRefreshToken).toEqual(expect.any(String));

    const blockedProjectsResponse = await request(app)
      .get('/api/projects/projects')
      .set('Authorization', `Bearer ${inviteAccessToken}`);
    expect(blockedProjectsResponse.status).toBe(403);
    expect(blockedProjectsResponse.body).toMatchObject({ code: 'password_setup_required' });

    const invitePasswordResponse = await request(app)
      .put('/api/auth/password-setup')
      .set('Authorization', `Bearer ${inviteAccessToken}`)
      .send({ password: INVITE_PASSWORD });
    expect(invitePasswordResponse.status).toBe(200);

    const refreshResponse = await fetch(
      `${LOCAL_SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: {
          apikey: anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: inviteRefreshToken }),
      }
    );
    expect(refreshResponse.status).toBe(400);

    const completedInviteSession = await requestPasswordGrant(inviteEmail, INVITE_PASSWORD);
    expect(completedInviteSession.response.status).toBe(200);
    expect(completedInviteSession.body.access_token).toEqual(expect.any(String));
    const completedInviteMetadata = readJwtPayload(
      completedInviteSession.body.access_token as string
    ).app_metadata as Record<string, unknown>;
    expect(completedInviteMetadata.password_setup_required).toBeUndefined();

    const admittedProjectsResponse = await request(app)
      .get('/api/projects/projects')
      .set('Authorization', `Bearer ${completedInviteSession.body.access_token}`);
    expect(admittedProjectsResponse.status).toBe(200);

    const laterMagicLinkResponse = await fetch(
      `${LOCAL_SUPABASE_URL}/auth/v1/admin/generate_link`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ type: 'magiclink', email: inviteEmail }),
      }
    );
    const laterMagicLink = await readJsonResponse<{ action_link?: string }>(laterMagicLinkResponse);
    expect(laterMagicLinkResponse.status).toBe(200);
    const laterMagicCallback = await fetch(laterMagicLink.action_link as string, {
      redirect: 'manual',
    });
    const laterMagicParams = new URLSearchParams(
      new URL(laterMagicCallback.headers.get('location') || '').hash.replace(/^#/, '')
    );
    const laterMagicAccessToken = laterMagicParams.get('access_token');
    expect(laterMagicParams.get('type')).toBe('magiclink');
    expect(laterMagicAccessToken).toEqual(expect.any(String));
    const laterMagicMetadata = readJwtPayload(laterMagicAccessToken as string)
      .app_metadata as Record<string, unknown>;
    expect(laterMagicMetadata.password_setup_required).toBeUndefined();
    const laterMagicProjectsResponse = await request(app)
      .get('/api/projects/projects')
      .set('Authorization', `Bearer ${laterMagicAccessToken}`);
    expect(laterMagicProjectsResponse.status).toBe(200);

    const reusedInviteCallback = await fetch(inviteLink.action_link as string, {
      redirect: 'manual',
    });
    expect(reusedInviteCallback.status).toBe(303);
    expect(new URL(reusedInviteCallback.headers.get('location') || '').hash).toContain(
      'error_code=otp_expired'
    );

    const recoveryUser = await createUser('recovery-link');
    const recoveryLinkResponse = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ type: 'recovery', email: recoveryUser.email }),
    });
    const recoveryLink = await readJsonResponse<{
      action_link?: string;
      verification_type?: string;
    }>(recoveryLinkResponse);
    expect(recoveryLinkResponse.status).toBe(200);
    expect(recoveryLink.verification_type).toBe('recovery');

    const recoveryCallback = await fetch(recoveryLink.action_link as string, {
      redirect: 'manual',
    });
    expect(recoveryCallback.status).toBe(303);
    const recoveryCallbackParams = new URLSearchParams(
      new URL(recoveryCallback.headers.get('location') || '').hash.replace(/^#/, '')
    );
    expect(recoveryCallbackParams.get('type')).toBe('recovery');
    const recoveryAccessToken = recoveryCallbackParams.get('access_token');
    expect(recoveryAccessToken).toEqual(expect.any(String));

    const recoveryPasswordResponse = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${recoveryAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: RECOVERY_PASSWORD }),
    });
    expect(recoveryPasswordResponse.status).toBe(200);
    expect(
      (await requestPasswordGrant(recoveryUser.email, RECOVERY_PASSWORD)).response.status
    ).toBe(200);
    expect((await requestPasswordGrant(recoveryUser.email, TEST_PASSWORD)).response.ok).toBe(false);

    const signupResponse = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: unknownEmail, password: TEST_PASSWORD }),
    });
    expect(signupResponse.ok).toBe(false);

    const unknownOtpResponse = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/otp`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        create_user: false,
        email: unknownEmail,
        type: 'magiclink',
      }),
    });
    expect(unknownOtpResponse.status).toBe(422);
    expect(await readJsonResponse<{ error_code?: string }>(unknownOtpResponse)).toMatchObject({
      error_code: 'otp_disabled',
    });

    const unknownRecoveryResponse = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: unknownEmail }),
    });
    expect(unknownRecoveryResponse.status).toBe(200);

    const unknownRows = await sql<Array<{ count: number }>>`
      select count(*)::int as count from auth.users where email = ${unknownEmail}
    `;
    expect(unknownRows[0]?.count).toBe(0);
  });

  testMagicLinkSmtp('submits a magic-link email to the configured local SMTP server', async () => {
    const user = await createUser('magic-link', MAGIC_LINK_TEST_EMAIL);

    const magicLinkResponse = await request(app)
      .post(`/api/admin/users/${user.id}/magic-link`)
      .set('Authorization', adminAuthorization)
      .send();
    expect(magicLinkResponse.status).toBe(200);
    expect(magicLinkResponse.body).toMatchObject({ success: true, sent: true });
  });
});
