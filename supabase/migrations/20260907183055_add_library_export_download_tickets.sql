create table if not exists public.library_export_download_tickets (
  token_sha256 text primary key check (token_sha256 ~ '^[0-9a-f]{64}$'),
  run_id uuid not null references public.library_export_runs(id) on delete cascade
);

create index if not exists library_export_download_tickets_run_id_idx
  on public.library_export_download_tickets(run_id);

alter table public.library_export_download_tickets enable row level security;
revoke all on public.library_export_download_tickets from public, anon, authenticated;
grant select, insert, delete on public.library_export_download_tickets to service_role;

-- Preserve a previously issued token without renewing the archive's completed_at deadline.
insert into public.library_export_download_tickets (token_sha256, run_id)
select download_token_sha256, id from public.library_export_runs
where download_token_sha256 is not null and status = 'completed'
on conflict (token_sha256) do nothing;

update public.library_export_runs set download_token_sha256 = null
where download_token_sha256 is not null;

comment on column public.library_export_runs.download_token_sha256 is
  'Retired: outstanding tickets are stored in library_export_download_tickets.';
