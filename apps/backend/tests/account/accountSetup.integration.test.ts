import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences.js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PostgresAccountStore } from '../../src/account/accountStore.js';

// This suite owns the entire disposable database, never a shared Supabase instance.
const databaseUrl = process.env.ACCOUNT_SETUP_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'initial setup migration and persistence in an empty disposable database',
  () => {
    const sql = postgres(databaseUrl ?? '', { max: 1 });
    const store = new PostgresAccountStore(sql);
    const existing = randomUUID();
    const newUser = randomUUID();
    beforeAll(async () => {
      await sql.unsafe(
        'create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);'
      );
      await sql`insert into auth.users(id) values (${existing})`;
      await sql.unsafe(
        'create table public.account_preferences(user_id uuid primary key references auth.users(id) on delete cascade, preferences jsonb not null)'
      );
      await sql.unsafe(
        await readFile('supabase/migrations/20260909120000_account_setup.sql', 'utf8')
      );
      await sql`insert into auth.users(id) values (${newUser})`;
    });
    afterAll(async () => {
      await sql.end();
    });
    test('enrolls only users inserted after migration and preserves settings when skipped', async () => {
      expect(await store.readSetupStatus(existing)).toBe('not-required');
      expect(await store.readSetupStatus(newUser)).toBe('pending');
      const preferences = {
        ...EMPTY_ACCOUNT_PREFERENCES,
        teachingPreferences: 'Spiega i simboli.',
      };
      await store.savePreferences(newUser, preferences);
      await store.finishSetup(newUser, { status: 'skipped' });
      expect(await store.readSetupStatus(newUser)).toBe('skipped');
      expect(await store.readPreferences(newUser)).toEqual(preferences);
      await store.clearPreferences(newUser);
      expect(await store.readSetupStatus(newUser)).toBe('skipped');
    });
    test('supports explicit setup for existing accounts and persists completion with preferences', async () => {
      await store.finishSetup(existing, {
        status: 'completed',
        preferences: EMPTY_ACCOUNT_PREFERENCES,
      });
      expect(await new PostgresAccountStore(sql).readSetupStatus(existing)).toBe('completed');
      expect(await store.readPreferences(existing)).toEqual(EMPTY_ACCOUNT_PREFERENCES);
    });
    test('rolls back preferences if the completion write fails', async () => {
      const failingUser = randomUUID();
      await sql`insert into auth.users(id) values (${failingUser})`;
      await sql.unsafe(
        `alter table public.account_setup add constraint reject_test_completion check (user_id <> '${failingUser}' or status <> 'completed')`
      );
      await expect(
        store.finishSetup(failingUser, {
          status: 'completed',
          preferences: { ...EMPTY_ACCOUNT_PREFERENCES, teachingPreferences: 'Must roll back.' },
        })
      ).rejects.toMatchObject({ code: '23514' });
      expect(await store.readSetupStatus(failingUser)).toBe('pending');
      expect(await store.readPreferences(failingUser)).toEqual(EMPTY_ACCOUNT_PREFERENCES);
    });
    test.each(['anon', 'authenticated'])('denies direct access by %s', async role => {
      await expect(
        sql.begin(async transaction => {
          await transaction.unsafe(`set local role ${role}`);
          await transaction`select * from public.account_setup`;
        })
      ).rejects.toMatchObject({ code: '42501' });
    });
  }
);
