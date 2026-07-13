alter table public.model_config
  add column if not exists artifact_model text not null default 'openai/gpt-5.4-mini',
  add column if not exists artifact_reasoning_effort text not null default 'medium'
    check (artifact_reasoning_effort in ('none', 'low', 'medium', 'high')),
  add column if not exists codex_artifact_model text not null default 'gpt-5.6-terra',
  add column if not exists openai_artifact_model text not null default 'gpt-5.6-terra';
