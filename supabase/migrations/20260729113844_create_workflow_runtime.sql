create table public.workflow_runs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text,
  workflow_id text not null check (length(btrim(workflow_id)) > 0),
  definition_hash text not null check (definition_hash ~ '^[a-f0-9]{64}$'),
  definition_hash_version integer not null check (definition_hash_version > 0),
  request_key text not null check (length(btrim(request_key)) > 0),
  dedupe_key text check (dedupe_key is null or length(btrim(dedupe_key)) > 0),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'expired')),
  cleanup_status text not null default 'not-required'
    check (cleanup_status in ('not-required', 'pending', 'running', 'completed', 'failed')),
  input jsonb not null,
  output jsonb,
  resolved_config jsonb not null,
  step_policies jsonb not null check (jsonb_typeof(step_policies) = 'object'),
  error jsonb,
  cancellation_requested boolean not null default false,
  next_event_sequence bigint not null default 0 check (next_event_sequence >= 0),
  next_completion_sequence bigint not null default 0 check (next_completion_sequence >= 0),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  check (
    (status in ('completed', 'failed', 'cancelled', 'expired') and completed_at is not null)
    or (status in ('queued', 'running', 'waiting') and completed_at is null)
  ),
  check (status <> 'completed' or output is not null),
  unique (user_id, workflow_id, request_key),
  unique (id, user_id),
  foreign key (user_id, project_id) references public.projects(user_id, id) on delete cascade
);

create unique index workflow_runs_active_dedupe_idx
  on public.workflow_runs(user_id, dedupe_key)
  where dedupe_key is not null
    and status in ('queued', 'running', 'waiting');

create index workflow_runs_owner_updated_idx
  on public.workflow_runs(user_id, updated_at desc, id);

create table public.workflow_node_runs (
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  node_instance_id text not null check (length(btrim(node_instance_id)) > 0),
  node_definition_id text not null check (length(btrim(node_definition_id)) > 0),
  parent_instance_id text,
  branch_key text,
  item_key text,
  kind text not null
    check (kind in ('emit', 'fanOut', 'repeat', 'routeBy', 'sequence', 'step', 'workflow', 'waitForSignal')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retrying', 'waiting', 'completed', 'failed', 'cancelled')),
  input jsonb not null,
  output jsonb,
  error jsonb,
  runtime_state jsonb,
  available_at timestamptz not null default now(),
  worker_id text,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null check (max_attempts > 0),
  timeout_ms integer not null check (timeout_ms > 0),
  has_undo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  completion_sequence bigint check (completion_sequence > 0),
  check (
    (status = 'running' and worker_id is not null and lease_expires_at is not null)
    or (status <> 'running' and worker_id is null and lease_expires_at is null)
  ),
  check ((status = 'completed' and completed_at is not null) or status <> 'completed'),
  check (status <> 'completed' or output is not null),
  primary key (run_id, node_instance_id)
);

create index workflow_node_runs_claim_idx
  on public.workflow_node_runs(available_at, created_at, run_id, node_instance_id)
  where status in ('queued', 'retrying');

create index workflow_node_runs_lease_idx
  on public.workflow_node_runs(lease_expires_at, run_id, node_instance_id)
  where status = 'running';

create unique index workflow_node_runs_completion_sequence_idx
  on public.workflow_node_runs(run_id, completion_sequence)
  where completion_sequence is not null;

create table public.workflow_node_attempts (
  run_id uuid not null,
  node_instance_id text not null,
  attempt_number integer not null check (attempt_number > 0),
  fencing_token bigint not null check (fencing_token > 0),
  worker_id text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'lost', 'cancelled')),
  error jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  ),
  primary key (run_id, node_instance_id, attempt_number),
  foreign key (run_id, node_instance_id)
    references public.workflow_node_runs(run_id, node_instance_id) on delete cascade
);

create table public.workflow_waits (
  id uuid primary key,
  run_id uuid not null,
  node_instance_id text not null,
  signal_type text not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'consumed', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  consumed_at timestamptz,
  finished_at timestamptz,
  check (expires_at > created_at),
  check (
    (status = 'waiting' and consumed_at is null and finished_at is null)
    or (status = 'consumed' and consumed_at is not null and finished_at is not null)
    or (status in ('cancelled', 'expired') and consumed_at is null and finished_at is not null)
  ),
  unique (run_id, node_instance_id),
  unique (id, run_id),
  unique (id, run_id, signal_type),
  foreign key (run_id, node_instance_id)
    references public.workflow_node_runs(run_id, node_instance_id) on delete cascade
);

create table public.workflow_signals (
  id uuid primary key,
  wait_id uuid not null unique,
  run_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_key text not null check (length(btrim(request_key)) > 0),
  signal_type text not null check (length(btrim(signal_type)) > 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, request_key),
  foreign key (wait_id, run_id, signal_type)
    references public.workflow_waits(id, run_id, signal_type) on delete cascade,
  foreign key (run_id, user_id) references public.workflow_runs(id, user_id) on delete cascade
);

create table public.workflow_undo_runs (
  run_id uuid not null,
  node_instance_id text not null,
  reverse_order integer not null check (reverse_order >= 0),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retrying', 'completed', 'failed')),
  input jsonb not null,
  output jsonb not null,
  error jsonb,
  available_at timestamptz not null default now(),
  worker_id text,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null check (max_attempts > 0),
  timeout_ms integer not null check (timeout_ms > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (status = 'running' and worker_id is not null and lease_expires_at is not null)
    or (status <> 'running' and worker_id is null and lease_expires_at is null)
  ),
  check ((status = 'completed' and completed_at is not null) or status <> 'completed'),
  primary key (run_id, node_instance_id),
  foreign key (run_id, node_instance_id)
    references public.workflow_node_runs(run_id, node_instance_id) on delete cascade
);

create index workflow_undo_runs_claim_idx
  on public.workflow_undo_runs(available_at, reverse_order, run_id, node_instance_id)
  where status in ('queued', 'retrying');

create index workflow_waits_expiry_idx
  on public.workflow_waits(expires_at, run_id, node_instance_id)
  where status = 'waiting';

create table public.workflow_undo_attempts (
  run_id uuid not null,
  node_instance_id text not null,
  attempt_number integer not null check (attempt_number > 0),
  fencing_token bigint not null check (fencing_token > 0),
  worker_id text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'lost')),
  error jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  ),
  primary key (run_id, node_instance_id, attempt_number),
  foreign key (run_id, node_instance_id)
    references public.workflow_undo_runs(run_id, node_instance_id) on delete cascade
);

create table public.workflow_outbox (
  id uuid primary key,
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  event_type text not null,
  schema_version integer not null default 1 check (schema_version > 0),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'delivering', 'delivered')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  worker_id text,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  last_error jsonb,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  check (
    (status = 'delivering' and worker_id is not null and lease_expires_at is not null)
    or (status <> 'delivering' and worker_id is null and lease_expires_at is null)
  ),
  check ((status = 'delivered' and delivered_at is not null) or status <> 'delivered'),
  unique (run_id, sequence)
);

create index workflow_outbox_delivery_idx
  on public.workflow_outbox(available_at, created_at, id)
  where status = 'pending';

create index workflow_outbox_lease_idx
  on public.workflow_outbox(lease_expires_at, id)
  where status = 'delivering';

alter table public.workflow_runs enable row level security;
alter table public.workflow_node_runs enable row level security;
alter table public.workflow_node_attempts enable row level security;
alter table public.workflow_waits enable row level security;
alter table public.workflow_signals enable row level security;
alter table public.workflow_undo_runs enable row level security;
alter table public.workflow_undo_attempts enable row level security;
alter table public.workflow_outbox enable row level security;

revoke all on public.workflow_runs from anon, authenticated;
revoke all on public.workflow_node_runs from anon, authenticated;
revoke all on public.workflow_node_attempts from anon, authenticated;
revoke all on public.workflow_waits from anon, authenticated;
revoke all on public.workflow_signals from anon, authenticated;
revoke all on public.workflow_undo_runs from anon, authenticated;
revoke all on public.workflow_undo_attempts from anon, authenticated;
revoke all on public.workflow_outbox from anon, authenticated;

grant select, insert, update, delete on public.workflow_runs to service_role;
grant select, insert, update, delete on public.workflow_node_runs to service_role;
grant select, insert, update, delete on public.workflow_node_attempts to service_role;
grant select, insert, update, delete on public.workflow_waits to service_role;
grant select, insert, update, delete on public.workflow_signals to service_role;
grant select, insert, update, delete on public.workflow_undo_runs to service_role;
grant select, insert, update, delete on public.workflow_undo_attempts to service_role;
grant select, insert, update, delete on public.workflow_outbox to service_role;
