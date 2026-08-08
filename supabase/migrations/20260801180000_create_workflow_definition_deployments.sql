create table public.workflow_definition_deployments (
  workflow_id text primary key check (length(btrim(workflow_id)) > 0),
  current_deployment jsonb not null check (jsonb_typeof(current_deployment) = 'object'),
  previous_deployment jsonb check (
    previous_deployment is null or jsonb_typeof(previous_deployment) = 'object'
  ),
  updated_at timestamptz not null default now()
);

alter table public.workflow_definition_deployments enable row level security;

revoke all on public.workflow_definition_deployments from anon, authenticated;
grant select, insert, update, delete on public.workflow_definition_deployments to service_role;
