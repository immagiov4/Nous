create table if not exists public.project_covers (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  name text not null,
  mime_type text not null,
  byte_size bigint not null,
  data bytea not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

alter table public.project_covers enable row level security;

create policy "project covers isolated by owner"
  on public.project_covers for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete
  on public.project_covers
  to authenticated, service_role;
