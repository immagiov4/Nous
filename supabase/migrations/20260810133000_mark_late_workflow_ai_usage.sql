alter table public.workflow_ai_usage
  add column reported_after_interruption boolean not null default false;
