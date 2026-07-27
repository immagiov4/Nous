create table if not exists public.waitlist_entries (
  email varchar(254) primary key,
  created_at timestamptz not null default now(),
  constraint waitlist_email_is_normalized check (email = lower(btrim(email))),
  constraint waitlist_email_has_shape check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

alter table public.waitlist_entries enable row level security;

revoke all on public.waitlist_entries from anon, authenticated;
