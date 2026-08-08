insert into storage.buckets (id, name, public)
values ('project-assets', 'project-assets', false)
on conflict (id) do update set public = false;

alter table public.workflow_runs
  add constraint workflow_runs_asset_scope_unique unique (id, user_id, project_id);

create table public.project_assets (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  user_id uuid not null,
  project_id text not null,
  workflow_run_id uuid not null,
  node_instance_id text not null,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  byte_size bigint not null check (byte_size >= 0),
  media_type text not null check (length(btrim(media_type)) > 0),
  object_path text not null unique check (length(btrim(object_path)) > 0),
  state text not null default 'staged'
    check (state in ('staged', 'active', 'deletion-pending')),
  cleanup_worker_id text,
  cleanup_lease_expires_at timestamptz,
  cleanup_fencing_token bigint not null default 0 check (cleanup_fencing_token >= 0),
  cleanup_attempt_count integer not null default 0 check (cleanup_attempt_count >= 0),
  last_cleanup_error jsonb,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  deletion_queued_at timestamptz,
  unique (id, user_id, project_id),
  foreign key (user_id, project_id)
    references public.projects(user_id, id),
  foreign key (workflow_run_id, user_id, project_id)
    references public.workflow_runs(id, user_id, project_id),
  foreign key (workflow_run_id, node_instance_id)
    references public.workflow_node_runs(run_id, node_instance_id),
  check (
    (cleanup_worker_id is null and cleanup_lease_expires_at is null)
    or (
      state = 'deletion-pending'
      and cleanup_worker_id is not null
      and cleanup_lease_expires_at is not null
    )
  ),
  check ((state = 'active' and activated_at is not null) or state <> 'active'),
  check (
    (state = 'deletion-pending' and deletion_queued_at is not null)
    or state <> 'deletion-pending'
  )
);

create table public.project_asset_deletions (
  object_path text primary key check (length(btrim(object_path)) > 0),
  created_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  cleanup_worker_id text,
  cleanup_lease_expires_at timestamptz,
  cleanup_fencing_token bigint not null default 0 check (cleanup_fencing_token >= 0),
  last_error jsonb,
  check (
    (cleanup_worker_id is null and cleanup_lease_expires_at is null)
    or (cleanup_worker_id is not null and cleanup_lease_expires_at is not null)
  )
);

create index project_assets_cleanup_claim_idx
  on public.project_assets(deletion_queued_at, id)
  where state = 'deletion-pending';

create index project_assets_run_node_idx
  on public.project_assets(workflow_run_id, node_instance_id, state, id);

alter table public.project_assets enable row level security;
alter table public.project_asset_deletions enable row level security;

revoke all on public.project_assets from anon, authenticated;
revoke all on public.project_asset_deletions from anon, authenticated;

grant select, insert, update, delete on public.project_assets to service_role;
grant select, insert, update, delete on public.project_asset_deletions to service_role;
