-- Paid narration belongs to its authenticated owner; browser clients use the backend.
create table public.speech_preparations (
  owner_id text not null,
  cache_key text not null,
  narration jsonb not null check (jsonb_typeof(narration) = 'object'),
  primary key (owner_id, cache_key)
);
alter table public.speech_preparations enable row level security;
revoke all on public.speech_preparations from anon, authenticated;
grant all on public.speech_preparations to service_role;
