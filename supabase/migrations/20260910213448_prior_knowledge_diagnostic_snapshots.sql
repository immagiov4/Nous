create table public.prior_knowledge_diagnostic_snapshots (
  user_id uuid not null,
  project_id text not null,
  incarnation_id uuid not null,
  diagnostic_id text not null,
  revision_id text not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  recorded_at timestamptz not null,
  primary key (user_id, project_id, incarnation_id, diagnostic_id, revision_id),
  foreign key (user_id, project_id) references public.projects(user_id, id) on delete cascade
);

-- Criteria and original responses are served only through authorized backend projections.
alter table public.prior_knowledge_diagnostic_snapshots enable row level security;
revoke all on public.prior_knowledge_diagnostic_snapshots from public, anon, authenticated;
grant select, insert, delete on public.prior_knowledge_diagnostic_snapshots to service_role;
