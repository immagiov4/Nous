alter table public.feedback_reports
  add column if not exists source text not null default 'app'
    check (source in ('app', 'github')),
  add column if not exists github_issue_state text
    check (github_issue_state in ('open', 'closed')),
  add column if not exists github_issue_title text,
  add column if not exists github_issue_body text,
  add column if not exists github_labels jsonb not null default '[]'::jsonb,
  add column if not exists github_updated_at timestamptz;

create unique index if not exists feedback_reports_github_issue_number_idx
  on public.feedback_reports(github_issue_number)
  where github_issue_number is not null;

comment on column public.feedback_reports.source is
  'Origin of the report. GitHub remains authoritative for synchronized issue fields.';

comment on column public.feedback_reports.github_issue_body is
  'GitHub issue body mirrored separately so private in-app diagnostics remain local.';
