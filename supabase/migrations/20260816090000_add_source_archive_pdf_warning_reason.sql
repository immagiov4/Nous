alter table public.project_source_entries
add column warning_reason text;

alter table public.project_sources
add column representation_hash text
check (representation_hash is null or representation_hash ~ '^[0-9a-f]{64}$');

alter table public.project_source_entries
add constraint project_source_entries_warning_reason_check
check (
  warning_reason is null
  or (
    kind = 'file'
    and warning_reason in ('no-usable-text', 'parser-failed', 'safety-limit', 'timeout')
  )
);
