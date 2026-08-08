alter table public.project_assets
  add column origin_kind text not null default 'workflow'
    check (origin_kind in ('workflow', 'archive-import')),
  alter column workflow_run_id drop not null,
  alter column node_instance_id drop not null;

alter table public.project_assets
  add constraint project_assets_origin_scope_check check (
    (
      origin_kind = 'workflow'
      and workflow_run_id is not null
      and node_instance_id is not null
    )
    or (
      origin_kind = 'archive-import'
      and workflow_run_id is null
      and node_instance_id is null
    )
  );

drop index if exists public.project_assets_run_node_idx;

create index project_assets_run_node_idx
  on public.project_assets(workflow_run_id, node_instance_id, state, id)
  where origin_kind = 'workflow';
