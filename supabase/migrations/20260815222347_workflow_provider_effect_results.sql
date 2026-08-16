create table public.workflow_provider_effect_results (
  idempotency_key text primary key check (length(btrim(idempotency_key)) > 0),
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  node_instance_id text not null check (length(btrim(node_instance_id)) > 0),
  output jsonb,
  ai_usage jsonb not null default '[]'::jsonb check (jsonb_typeof(ai_usage) = 'array'),
  finalized boolean not null default false,
  created_at timestamptz not null default now(),
  check (
    (not finalized and output is not null)
    or (finalized and output is null and ai_usage = '[]'::jsonb)
  )
);

alter table public.workflow_provider_effect_results enable row level security;

revoke all on public.workflow_provider_effect_results from anon, authenticated;
grant select, insert, update, delete on public.workflow_provider_effect_results to service_role;

create function public.finalize_workflow_provider_effect_results()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.workflow_provider_effect_results
  set output = null, ai_usage = '[]'::jsonb, finalized = true
  where run_id = new.run_id and node_instance_id = new.node_instance_id;
  return new;
end;
$$;

revoke all on function public.finalize_workflow_provider_effect_results() from public, anon, authenticated;
grant execute on function public.finalize_workflow_provider_effect_results() to service_role;

create trigger finalize_workflow_provider_effect_results
after update of status on public.workflow_node_runs
for each row
when (new.status in ('completed', 'failed', 'cancelled'))
execute function public.finalize_workflow_provider_effect_results();
