create table public.workflow_definition_registry_deployments (
  registry_scope text primary key check (length(btrim(registry_scope)) > 0),
  current_workflow_set_version bigint not null default 1
    check (current_workflow_set_version > 0),
  current_manifest jsonb not null check (jsonb_typeof(current_manifest) = 'array'),
  previous_workflow_set_version bigint
    check (previous_workflow_set_version is null or previous_workflow_set_version > 0),
  previous_manifest jsonb check (
    previous_manifest is null or jsonb_typeof(previous_manifest) = 'array'
  ),
  removed_workflow_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(removed_workflow_ids) = 'array'),
  updated_at timestamptz not null default now()
);

insert into public.workflow_definition_registry_deployments (
  registry_scope,
  current_manifest
)
select
  'nous-reader',
  coalesce(jsonb_agg(current_deployment order by workflow_id), '[]'::jsonb)
from public.workflow_definition_deployments
having count(*) > 0;

alter table public.workflow_definition_registry_deployments enable row level security;

revoke all on public.workflow_definition_registry_deployments from anon, authenticated;
grant select, insert, update, delete
  on public.workflow_definition_registry_deployments
  to service_role;
