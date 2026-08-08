alter table public.workflow_signals
  add column request_payload jsonb;

update public.workflow_signals
set request_payload = payload;

alter table public.workflow_signals
  alter column request_payload set not null;
