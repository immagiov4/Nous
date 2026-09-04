alter table public.library_export_runs
  drop constraint library_export_runs_status_check,
  add constraint library_export_runs_status_check
    check (status in ('running', 'completed', 'failed', 'cancelled', 'downloaded')),
  add column cleanup_completed_at timestamptz,
  add column download_token_sha256 text
    check (download_token_sha256 is null or download_token_sha256 ~ '^[0-9a-f]{64}$');

drop index public.library_export_runs_one_undelivered_per_user_idx;

create unique index library_export_runs_one_undelivered_per_user_idx
  on public.library_export_runs(user_id)
  where status not in ('cancelled', 'downloaded');
