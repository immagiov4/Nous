-- Live model configuration for lesson playback preparation.
alter table public.model_config
  add column if not exists playback_preparation_model text not null default 'anthropic/claude-haiku-5.5',
  add column if not exists playback_preparation_reasoning_effort text not null default 'low'
    check (playback_preparation_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  add column if not exists codex_playback_preparation_model text not null default 'gpt-6-luna',
  add column if not exists openai_playback_preparation_model text not null default 'gpt-6-luna';
