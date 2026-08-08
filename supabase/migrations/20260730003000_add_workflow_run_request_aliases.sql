create table public.workflow_run_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id text not null check (length(btrim(workflow_id)) > 0),
  request_key text not null check (length(btrim(request_key)) > 0),
  run_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, workflow_id, request_key),
  foreign key (run_id, user_id)
    references public.workflow_runs(id, user_id) on delete cascade
);

insert into public.workflow_run_requests (user_id, workflow_id, request_key, run_id, created_at)
select user_id, workflow_id, request_key, id, created_at
from public.workflow_runs;

create index workflow_run_requests_run_idx
  on public.workflow_run_requests(run_id);

alter table public.workflow_run_requests enable row level security;

revoke all on public.workflow_run_requests from anon, authenticated;
grant select, insert, update, delete on public.workflow_run_requests to service_role;
