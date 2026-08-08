alter table public.workflow_runs
  add column if not exists step_policies_version smallint not null default 1;
