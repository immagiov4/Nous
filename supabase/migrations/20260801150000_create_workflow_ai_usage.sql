create table public.workflow_ai_usage (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  node_instance_id text not null,
  attempt_number integer not null check (attempt_number > 0),
  provider text not null check (length(btrim(provider)) > 0),
  model text not null check (length(btrim(model)) > 0),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  reasoning_tokens integer check (reasoning_tokens >= 0),
  cache_read_tokens integer check (cache_read_tokens >= 0),
  cache_write_tokens integer check (cache_write_tokens >= 0),
  provider_cost numeric(20, 12) check (provider_cost >= 0),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (run_id, node_instance_id, attempt_number)
    references public.workflow_node_attempts(run_id, node_instance_id, attempt_number)
    on delete cascade
);

create index workflow_ai_usage_attempt_idx
  on public.workflow_ai_usage(run_id, node_instance_id, attempt_number, created_at, id);

alter table public.workflow_ai_usage enable row level security;

revoke all on public.workflow_ai_usage from anon, authenticated;
grant select, insert, update, delete on public.workflow_ai_usage to service_role;
