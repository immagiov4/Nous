alter table public.workflow_runs
  add column if not exists correlation_id uuid not null default gen_random_uuid();

create index if not exists workflow_runs_correlation_id_idx
  on public.workflow_runs(correlation_id);
