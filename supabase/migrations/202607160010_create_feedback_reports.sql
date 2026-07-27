create table if not exists public.feedback_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  reporter_email text,
  category text not null check (category in ('bug', 'enhancement')),
  title text,
  description text not null,
  diagnostics jsonb not null default '{}'::jsonb,
  content_hash text not null,
  client_request_id text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'submitted', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  github_issue_number bigint,
  github_issue_url text,
  screenshot_mime_type text check (screenshot_mime_type in ('image/jpeg', 'image/webp')),
  screenshot_byte_size integer check (
    screenshot_byte_size is null or screenshot_byte_size between 1 and 786432
  ),
  screenshot_data bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  check (char_length(description) between 1 and 5000),
  check (title is null or char_length(title) between 1 and 160),
  check (reporter_email is null or char_length(reporter_email) <= 320),
  check (char_length(content_hash) = 64),
  check (client_request_id is null or char_length(client_request_id) <= 100),
  check (octet_length(diagnostics::text) <= 200000),
  check (
    (screenshot_data is null and screenshot_mime_type is null and screenshot_byte_size is null)
    or (
      screenshot_data is not null
      and screenshot_mime_type is not null
      and screenshot_byte_size = octet_length(screenshot_data)
    )
  )
);

create unique index if not exists feedback_reports_user_client_request_idx
  on public.feedback_reports(user_id, client_request_id)
  where user_id is not null and client_request_id is not null;

create index if not exists feedback_reports_user_created_idx
  on public.feedback_reports(user_id, created_at desc);

create index if not exists feedback_reports_outbox_idx
  on public.feedback_reports(next_attempt_at, created_at)
  where status in ('pending', 'processing');

alter table public.feedback_reports enable row level security;

revoke all on public.feedback_reports from anon, authenticated;
grant select, insert, update, delete on public.feedback_reports to service_role;

comment on table public.feedback_reports is
  'Private authenticated user feedback and its persistent GitHub delivery outbox.';
