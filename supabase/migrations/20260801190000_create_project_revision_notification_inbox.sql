create table public.project_revision_notification_inbox (
  notification_id uuid primary key references public.workflow_outbox(id) on delete cascade,
  run_id uuid not null,
  user_id uuid not null,
  event_type text not null check (length(btrim(event_type)) > 0),
  schema_version integer not null check (schema_version > 0),
  sequence bigint not null check (sequence > 0),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (run_id, sequence),
  foreign key (run_id, user_id)
    references public.workflow_runs(id, user_id) on delete cascade
);

alter table public.project_revision_notification_inbox enable row level security;

revoke all on public.project_revision_notification_inbox from anon, authenticated;
grant select, insert, update, delete on public.project_revision_notification_inbox to service_role;
