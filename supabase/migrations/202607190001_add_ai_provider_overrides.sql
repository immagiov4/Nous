alter table public.model_config
  add column if not exists ai_provider_overrides jsonb not null default '{}'::jsonb;
