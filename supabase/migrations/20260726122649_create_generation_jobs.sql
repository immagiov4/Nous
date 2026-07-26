create table public.generation_jobs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  kind text not null check (kind in ('lesson', 'image')),
  dedupe_key text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  stage text not null default 'queued',
  payload jsonb not null,
  result jsonb,
  error_code text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  foreign key (user_id, project_id) references public.projects(user_id, id) on delete cascade
);

create unique index generation_jobs_active_dedupe_idx
  on public.generation_jobs(user_id, dedupe_key)
  where status in ('queued', 'running');

create unique index generation_jobs_active_project_lesson_idx
  on public.generation_jobs(user_id, project_id)
  where kind = 'lesson' and status in ('queued', 'running');

create index generation_jobs_queue_idx
  on public.generation_jobs(status, created_at)
  where status = 'queued';

create index generation_jobs_user_updated_idx
  on public.generation_jobs(user_id, updated_at desc);

alter table public.generation_jobs enable row level security;

create policy "generation jobs readable by owner"
  on public.generation_jobs for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.generation_jobs from anon, authenticated;
grant select on public.generation_jobs to authenticated;
grant select, insert, update, delete on public.generation_jobs to service_role;

select cron.schedule(
  'cleanup-generation-jobs',
  '15 3 * * *',
  $$ delete from public.generation_jobs where expires_at <= now() $$
);
