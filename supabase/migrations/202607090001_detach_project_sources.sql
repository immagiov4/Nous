create table if not exists public.project_sources (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  source_id text not null,
  source_hash text not null,
  name text not null,
  mime_type text not null,
  byte_size bigint not null,
  data bytea not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

alter table public.project_sources enable row level security;

create policy "project sources isolated by owner"
  on public.project_sources for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete
  on public.project_sources
  to authenticated, service_role;
