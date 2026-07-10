import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const initialMigrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/202607070001_initial_user_backend.sql'),
  'utf8'
);
const grantMigrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/202607070002_grant_api_table_access.sql'),
  'utf8'
);
const adminBootstrapMigrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/202607070003_bootstrap_admin_account.sql'),
  'utf8'
);
const waitlistMigrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/202607100001_create_waitlist.sql'),
  'utf8'
);
const modelReasoningMigrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/202607100002_add_model_reasoning_effort.sql'),
  'utf8'
);
const ttsModelMigrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/202607100003_replace_unavailable_tts_model.sql'),
  'utf8'
);

describe('Supabase initial user backend migration', () => {
  test('enables RLS and owner policies on every tenant table', () => {
    for (const table of [
      'profiles',
      'projects',
      'project_snapshots',
      'library_folders',
      'library_placements',
      'model_config',
    ]) {
      expect(initialMigrationSql).toContain(
        `alter table public.${table} enable row level security`
      );
    }

    expect(initialMigrationSql).toContain('using (auth.uid() = user_id)');
    expect(initialMigrationSql).toContain('with check (auth.uid() = user_id)');
    expect(initialMigrationSql).toContain("check (role in ('user', 'admin'))");
    expect(initialMigrationSql).toContain("using (auth.role() = 'authenticated')");
  });

  test('grants PostgREST roles enough table privileges for RLS to run', () => {
    expect(grantMigrationSql).toContain('to authenticated, service_role');
    expect(grantMigrationSql).toContain('on public.profiles');
    expect(grantMigrationSql).toContain('public.projects');
    expect(grantMigrationSql).toContain('public.project_snapshots');
    expect(grantMigrationSql).toContain('public.library_folders');
    expect(grantMigrationSql).toContain('public.library_placements');
    expect(grantMigrationSql).toContain('on public.model_config');
  });

  test('bootstraps the first admin account and migrates only guarded legacy tenant data to it', () => {
    expect(adminBootstrapMigrationSql).toContain('brancaccio@proton.me');
    expect(adminBootstrapMigrationSql).toContain('g1ovann1');
    expect(adminBootstrapMigrationSql).toContain('raw_app_meta_data = \'{"role": "admin"');
    expect(adminBootstrapMigrationSql).toContain('auth.identities');
    expect(adminBootstrapMigrationSql).toContain('legacy_owner_ids');
    expect(adminBootstrapMigrationSql).toContain('where user_id = any(legacy_owner_ids)');
    expect(adminBootstrapMigrationSql).not.toContain(
      'delete from public.projects where user_id <> admin_id'
    );
    expect(adminBootstrapMigrationSql).not.toContain(
      'delete from public.project_snapshots where user_id <> admin_id'
    );
  });

  test('stores normalized waitlist emails without exposing them through PostgREST', () => {
    expect(waitlistMigrationSql).toContain('create table if not exists public.waitlist_entries');
    expect(waitlistMigrationSql).toContain('primary key');
    expect(waitlistMigrationSql).toContain('enable row level security');
    expect(waitlistMigrationSql).toContain('revoke all on public.waitlist_entries');
    expect(waitlistMigrationSql).not.toContain('create policy');
  });

  test('stores independent reasoning effort for every text model slot', () => {
    expect(modelReasoningMigrationSql).toContain('lesson_reasoning_effort');
    expect(modelReasoningMigrationSql).toContain('context_reasoning_effort');
    expect(modelReasoningMigrationSql).toContain('assessment_reasoning_effort');
    expect(modelReasoningMigrationSql).toContain("('none', 'low', 'medium', 'high')");
  });

  test('replaces unavailable TTS defaults without touching custom model choices', () => {
    expect(ttsModelMigrationSql).toContain("tts_model = 'x-ai/grok-voice-tts-1.0'");
    expect(ttsModelMigrationSql).toContain("tts_voice = 'Ara'");
    expect(ttsModelMigrationSql).toContain("'openai/gpt-4o-mini-tts'");
    expect(ttsModelMigrationSql).toContain("'openai/gpt-4o-mini-tts-2025-12-15'");
    expect(ttsModelMigrationSql).toContain("'mistralai/voxtral-mini-tts-2603'");
  });
});
