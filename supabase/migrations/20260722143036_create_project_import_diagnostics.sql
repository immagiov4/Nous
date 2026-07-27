create table public.project_import_diagnostics (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  correlation_id uuid not null,
  code text not null,
  stage text not null,
  file_bytes bigint check (file_bytes is null or file_bytes >= 0),
  limit_bytes bigint check (limit_bytes is null or limit_bytes >= 0),
  project_count integer check (project_count is null or project_count >= 0),
  project_index integer check (project_index is null or project_index >= 0),
  created_at timestamptz not null default now()
);

create index project_import_diagnostics_created_at_idx
  on public.project_import_diagnostics(created_at);

create index project_import_diagnostics_correlation_id_idx
  on public.project_import_diagnostics(correlation_id);

alter table public.project_import_diagnostics enable row level security;

create policy "project import diagnostics insertable by owner"
  on public.project_import_diagnostics for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "project import diagnostics readable by admin"
  on public.project_import_diagnostics for select
  to authenticated
  using ((select public.is_admin()));

create policy "project import diagnostics deletable by admin"
  on public.project_import_diagnostics for delete
  to authenticated
  using ((select public.is_admin()));

revoke all
  on public.project_import_diagnostics
  from anon, authenticated;

grant insert, select, delete
  on public.project_import_diagnostics
  to service_role;

grant usage, select
  on sequence public.project_import_diagnostics_id_seq
  to service_role;

update public.projects
set meta = jsonb_set(meta, '{isFavorite}', 'false'::jsonb, true)
where not (meta ? 'isFavorite');

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'cleanup-project-import-diagnostics',
  '0 3 * * *',
  $$ delete from public.project_import_diagnostics where created_at < now() - interval '30 days' $$
);
