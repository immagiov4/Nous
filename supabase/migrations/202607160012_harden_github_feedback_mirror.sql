alter table public.feedback_reports
  drop constraint if exists feedback_reports_category_check,
  drop constraint if exists feedback_reports_github_issue_state_check;

alter table public.feedback_reports
  add constraint feedback_reports_category_check
    check (category in ('bug', 'enhancement', 'other')),
  add constraint feedback_reports_github_issue_state_check
    check (github_issue_state in ('open', 'closed', 'missing')),
  add column if not exists github_missing_sync_count integer not null default 0
    check (github_missing_sync_count >= 0);

comment on column public.feedback_reports.github_missing_sync_count is
  'Consecutive complete GitHub mirrors where this issue was absent; imported issues are removed after two.';
