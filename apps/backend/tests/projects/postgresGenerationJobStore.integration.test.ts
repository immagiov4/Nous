import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PostgresGenerationJobStore } from '../../src/projects/postgresGenerationJobStore.js';

const databaseUrl = process.env.DATABASE_URL;
const userId = randomUUID();
const projectId = `generation-jobs-${randomUUID()}`;
const sql = databaseUrl ? postgres(databaseUrl, { max: 2 }) : null;

describe.skipIf(!databaseUrl)('PostgresGenerationJobStore integration', () => {
  beforeAll(async () => {
    if (!sql) return;
    await sql`
      insert into auth.users (id, aud, role, created_at, updated_at)
      values (${userId}, 'authenticated', 'authenticated', now(), now())
    `;
    await sql`
      insert into public.projects (user_id, id, meta, updated_at, last_opened_at)
      values (${userId}, ${projectId}, '{}'::jsonb, now(), now())
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from auth.users where id = ${userId}`;
    await sql.end();
  });

  test('deduplicates atomically and claims a persisted job', async () => {
    if (!sql) throw new Error('DATABASE_URL is required.');
    const store = new PostgresGenerationJobStore(undefined, sql);
    const input = {
      dedupeKey: `lesson:${projectId}:lesson-1`,
      id: randomUUID(),
      kind: 'lesson' as const,
      payload: { projectId, sectionId: 'lesson-1' },
      projectId,
      userId,
    };

    const [first, duplicate] = await Promise.all([
      store.enqueue(input),
      store.enqueue({ ...input, id: randomUUID() }),
    ]);

    expect([first.created, duplicate.created].sort()).toEqual([false, true]);
    expect(first.job.id).toBe(duplicate.job.id);
    const claimed = await store.claimNext();
    expect(claimed?.id).toBe(first.job.id);
    expect(claimed?.attemptCount).toBe(1);
    expect(claimed?.status).toBe('running');

    await store.complete(first.job.id, { content: 'persisted' });
    const completed = await store.getForUser(userId, first.job.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toEqual({ content: 'persisted' });
  });

  test('allows only one active lesson job per project', async () => {
    if (!sql) throw new Error('DATABASE_URL is required.');
    const store = new PostgresGenerationJobStore(undefined, sql);
    const first = await store.enqueue({
      dedupeKey: `lesson:${projectId}:lesson-a`,
      id: randomUUID(),
      kind: 'lesson',
      payload: { projectId, sectionId: 'lesson-a' },
      projectId,
      userId,
    });
    const second = await store.enqueue({
      dedupeKey: `lesson:${projectId}:lesson-b`,
      id: randomUUID(),
      kind: 'lesson',
      payload: { projectId, sectionId: 'lesson-b' },
      projectId,
      userId,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });
});
