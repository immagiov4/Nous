create table public.library_export_runs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  correlation_id uuid not null,
  status text not null check (status in ('running', 'completed', 'failed', 'downloaded')),
  phase text not null check (
    phase in ('preparing', 'project-archive', 'library-archive', 'integrity-check', 'ready', 'failed')
  ),
  expected_projects jsonb not null check (jsonb_typeof(expected_projects) = 'array'),
  folders jsonb not null check (jsonb_typeof(folders) = 'array'),
  placements jsonb not null check (jsonb_typeof(placements) = 'array'),
  current_project_id text,
  bytes_written bigint not null default 0 check (bytes_written >= 0),
  archive_bytes bigint check (archive_bytes is null or archive_bytes >= 0),
  archive_sha256 text check (archive_sha256 is null or archive_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text,
  error_phase text,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  downloaded_at timestamptz
);

create unique index library_export_runs_one_undelivered_per_user_idx
  on public.library_export_runs(user_id)
  where status <> 'downloaded';

create index library_export_runs_correlation_id_idx
  on public.library_export_runs(correlation_id);

create table public.library_export_project_checkpoints (
  run_id uuid not null references public.library_export_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  project_index integer not null check (project_index >= 0),
  archive_path text not null,
  archive_bytes bigint not null check (archive_bytes >= 0),
  archive_sha256 text not null check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz not null default now(),
  primary key (run_id, project_id),
  unique (run_id, project_index)
);

alter table public.library_export_runs enable row level security;
alter table public.library_export_project_checkpoints enable row level security;

revoke all on public.library_export_runs from anon, authenticated;
revoke all on public.library_export_project_checkpoints from anon, authenticated;

grant select, insert, update on public.library_export_runs to service_role;
grant select, insert, update on public.library_export_project_checkpoints to service_role;
