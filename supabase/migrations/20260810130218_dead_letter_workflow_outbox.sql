alter table public.workflow_outbox
  add column dead_lettered_at timestamptz;

alter table public.workflow_outbox
  drop constraint workflow_outbox_status_check;

alter table public.workflow_outbox
  add constraint workflow_outbox_status_check
  check (status in ('pending', 'delivering', 'delivered', 'dead-letter'));

update public.workflow_outbox
set status = 'dead-letter',
    dead_lettered_at = clock_timestamp()
where status = 'pending'
  and last_error ->> 'kind' in ('corrective', 'permanent');

alter table public.workflow_outbox
  add constraint workflow_outbox_dead_letter_check
  check (
    (status = 'dead-letter' and dead_lettered_at is not null)
    or (status <> 'dead-letter' and dead_lettered_at is null)
  );

create index workflow_outbox_dead_letter_idx
  on public.workflow_outbox(dead_lettered_at desc, id)
  where status = 'dead-letter';
