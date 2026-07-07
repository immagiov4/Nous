create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  meta jsonb not null,
  updated_at timestamptz not null,
  last_opened_at timestamptz,
  server_updated_at timestamptz not null default now(),
  revision bigint not null default 1,
  primary key (user_id, id)
);

create table if not exists public.project_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  snapshot jsonb not null,
  document_index jsonb,
  updated_at timestamptz not null,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, id) references public.projects(user_id, id) on delete cascade
);

create table if not exists public.library_folders (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  folder jsonb not null,
  parent_folder_id text,
  order_index integer not null,
  updated_at timestamptz not null,
  primary key (user_id, id)
);

create table if not exists public.library_placements (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  placement jsonb not null,
  folder_id text,
  order_index integer not null,
  updated_at timestamptz not null,
  primary key (user_id, project_id),
  foreign key (user_id, project_id) references public.projects(user_id, id) on delete cascade
);

create table if not exists public.model_config (
  id text primary key default 'global' check (id = 'global'),
  lesson_model text not null,
  context_model text not null,
  assessment_model text not null,
  tts_model text not null,
  tts_voice text not null,
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_last_opened_idx
  on public.projects(user_id, last_opened_at desc nulls last, updated_at desc);

create index if not exists library_folders_user_parent_order_idx
  on public.library_folders(user_id, parent_folder_id, order_index, id);

create index if not exists library_placements_user_folder_order_idx
  on public.library_placements(user_id, folder_id, order_index, project_id);

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin';
$$;

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_snapshots enable row level security;
alter table public.library_folders enable row level security;
alter table public.library_placements enable row level security;
alter table public.model_config enable row level security;

create policy "profiles readable by owner or admin"
  on public.profiles for select
  using (auth.uid() = id or public.is_admin());

create policy "profiles writable by admin"
  on public.profiles for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "projects isolated by owner"
  on public.projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "project snapshots isolated by owner"
  on public.project_snapshots for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "library folders isolated by owner"
  on public.library_folders for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "library placements isolated by owner"
  on public.library_placements for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "model config readable by authenticated users"
  on public.model_config for select
  using (auth.role() = 'authenticated');

create policy "model config writable by admin"
  on public.model_config for all
  using (public.is_admin())
  with check (public.is_admin());
