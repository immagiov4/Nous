alter table public.workflow_waits
  add column signal_schema_version integer not null default 1
    check (signal_schema_version > 0);

alter table public.workflow_signals
  add column signal_schema_version integer not null default 1
    check (signal_schema_version > 0);

alter table public.workflow_waits
  add constraint workflow_waits_signal_schema_key
    unique (id, run_id, signal_type, signal_schema_version);

alter table public.workflow_signals
  add constraint workflow_signals_wait_schema_fkey
    foreign key (wait_id, run_id, signal_type, signal_schema_version)
    references public.workflow_waits(id, run_id, signal_type, signal_schema_version)
    on delete cascade;
