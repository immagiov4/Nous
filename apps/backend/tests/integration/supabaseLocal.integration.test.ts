import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/index.js';
import { PostgresProjectStore } from '../../src/projects/postgresProjectStore.js';
import { setProjectStoreForTesting } from '../../src/projects/projectStore.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
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
const MAGIC_LINK_TEST_EMAIL = process.env.SUPABASE_MAGIC_LINK_TEST_EMAIL?.trim();
const testMagicLinkSmtp = MAGIC_LINK_TEST_EMAIL ? test : test.skip;
const ORIGINAL_ENV = { ...process.env };

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
      sub: '00000000-0000-4000-8000-00000000ad01',
      exp: Math.floor(Date.now() / 1000) + 300,
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
    process.env.SUPABASE_JWT_SECRET = LOCAL_JWT_SECRET;
    process.env.SUPABASE_URL = LOCAL_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
  };

  beforeAll(async () => {
    applyLocalSupabaseEnvironment();
    setProjectStoreForTesting(store);
    await sql`delete from auth.users where email like ${`${TEST_EMAIL_PREFIX}-%@nous.local`}`;
  });

  beforeEach(() => {
    applyLocalSupabaseEnvironment();
  });

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await sql`delete from auth.users where email in ${sql(createdEmails)}`;
    }
    await sql`
      delete from public.model_config
      where id = 'global' and lesson_model like 'integration/%'
    `;
    await store.close();
    setProjectStoreForTesting(null);
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
    const response = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password: TEST_PASSWORD,
      }),
    });
    const body = await readJsonResponse<{ access_token?: string; error?: string }>(response);

    expect(response.status).toBe(200);
    expect(body.access_token).toEqual(expect.any(String));
    return body.access_token as string;
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

  test('persists model config', async () => {
    const configResponse = await request(app)
      .patch('/api/admin/model-config')
      .set('Authorization', adminAuthorization)
      .send({
        lessonModel: 'integration/lesson-model',
        contextModel: 'integration/context-model',
      });
    expect(configResponse.status).toBe(200);
    expect(configResponse.body.config).toMatchObject({
      lessonModel: 'integration/lesson-model',
      contextModel: 'integration/context-model',
    });

    const persistedRows = await sql<Array<{ lesson_model: string; context_model: string }>>`
      select lesson_model, context_model
      from public.model_config
      where id = 'global'
    `;
    expect(persistedRows[0]).toMatchObject({
      lesson_model: 'integration/lesson-model',
      context_model: 'integration/context-model',
    });
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
