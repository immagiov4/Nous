import { randomUUID } from 'node:crypto';
import { EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences.js';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PostgresAccountStore } from '../../src/account/accountStore.js';
import { summarizeAccountUsage } from '../../src/account/accountUsage.js';
import {
  createPostgresWorkflowIntegrationContext,
  setupPostgresWorkflowIntegrationContext,
  teardownPostgresWorkflowIntegrationContext,
} from '../workflows/postgresWorkflowStore.integration.fixture.js';

const context = createPostgresWorkflowIntegrationContext();
describe.skipIf(!context.enabled)('account Postgres persistence and ownership', () => {
  const otherUserId = randomUUID();
  const preferences = {
    interfaceLocale: 'it' as const,
    contentLanguage: 'English',
    teachingPreferences: 'One concept at a time.',
  };
  let sql: Sql;
  let store: PostgresAccountStore;
  beforeAll(async () => {
    if (!context.sql) throw new Error('Integration database is required.');
    sql = context.sql;
    store = new PostgresAccountStore(sql);
    await setupPostgresWorkflowIntegrationContext(context);
    await sql`insert into auth.users (id, aud, role) values (${otherUserId}, 'authenticated', 'authenticated')`;
  });
  afterAll(async () => {
    await sql`delete from auth.users where id = ${otherUserId}`;
    await teardownPostgresWorkflowIntegrationContext(context);
  });

  test('persists across store instances, isolates users and clears the saved row', async () => {
    expect(await store.readPreferences(context.userId)).toEqual(EMPTY_ACCOUNT_PREFERENCES);
    await store.savePreferences(context.userId, preferences);
    expect(await new PostgresAccountStore(sql).readPreferences(context.userId)).toEqual(
      preferences
    );
    expect(await store.readPreferences(otherUserId)).toEqual(EMPTY_ACCOUNT_PREFERENCES);
    await store.clearPreferences(otherUserId);
    expect(await store.readPreferences(context.userId)).toEqual(preferences);
    await store.clearPreferences(context.userId);
    expect(await store.readPreferences(context.userId)).toEqual(EMPTY_ACCOUNT_PREFERENCES);
  });

  test('RLS permits the owner and rejects cross-account reads, writes and deletion', async () => {
    await store.savePreferences(context.userId, preferences);
    await sql.begin(async transaction => {
      await transaction`select set_config('request.jwt.claim.sub', ${otherUserId}, true)`;
      await transaction`set local role authenticated`;
      expect(await transaction`select * from public.account_preferences`).toHaveLength(0);
      expect(
        await transaction`update public.account_preferences set preferences = '{}' where user_id = ${context.userId} returning user_id`
      ).toHaveLength(0);
      expect(
        await transaction`delete from public.account_preferences where user_id = ${context.userId} returning user_id`
      ).toHaveLength(0);
      await transaction`insert into public.account_preferences (user_id, preferences) values (${otherUserId}, ${sql.json(preferences)})`;
      expect(await transaction`select user_id from public.account_preferences`).toEqual([
        { user_id: otherUserId },
      ]);
    });
    await expect(
      sql.begin(async transaction => {
        await transaction`select set_config('request.jwt.claim.sub', ${otherUserId}, true)`;
        await transaction`set local role authenticated`;
        await transaction`insert into public.account_preferences (user_id, preferences) values (${context.userId}, '{}') on conflict (user_id) do update set preferences = excluded.preferences`;
      })
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql.begin(async transaction => {
        await transaction`set local role anon`;
        await transaction`select * from public.account_preferences`;
      })
    ).rejects.toMatchObject({ code: '42501' });
    expect(await store.readPreferences(context.userId)).toEqual(preferences);
  });

  test('aggregates only owned usage, separating reported cost and missing counters even after a course is deleted', async () => {
    const runId = randomUUID();
    await sql`insert into public.workflow_runs (id, user_id, project_id, workflow_id, definition_hash, definition_hash_version, request_key, input, resolved_config, step_policies)
      values (${runId}, ${context.userId}, ${context.projectId}, 'account-usage-test', ${'a'.repeat(64)}, 1, ${runId}, '{}', '{}', '{}')`;
    await sql`insert into public.workflow_node_runs (run_id, node_instance_id, node_definition_id, kind, input, max_attempts, timeout_ms)
      values (${runId}, 'step', 'step', 'step', '{}', 1, 1000)`;
    await sql`insert into public.workflow_node_attempts (run_id, node_instance_id, attempt_number, fencing_token, worker_id)
      values (${runId}, 'step', 1, 1, 'test')`;
    await sql`insert into public.workflow_ai_usage (run_id, node_instance_id, attempt_number, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, provider_cost)
      values (${runId}, 'step', 1, 'openrouter', 'test', 100, 20, 30, 0, 0.1),
      (${runId}, 'step', 1, 'openrouter', 'test', 100, 20, 30, 0, 0.2),
      (${runId}, 'step', 1, 'openrouter', 'test', 100, 20, 30, 0, null),
      (${runId}, 'step', 1, 'codex', 'test', null, null, null, null, null)`;
    const result = summarizeAccountUsage(await store.readUsage(context.userId), [], null);
    expect(result).toMatchObject({
      recordedCalls: 4,
      tokens: 360,
      missingTokenCalls: 1,
      missingCostCalls: 2,
    });
    expect(result.reportedCostUsd).toBeCloseTo(0.3);
    expect(await store.readUsage(otherUserId)).toEqual([]);
    await sql`delete from public.projects where user_id = ${context.userId} and id = ${context.projectId}`;
    expect(summarizeAccountUsage(await store.readUsage(context.userId), [], null)).toEqual(result);
  });
});
