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
});
