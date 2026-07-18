alter table public.model_config
  add column if not exists codex_structure_model text not null default 'gpt-5.6-luna',
  add column if not exists codex_drafting_model text not null default 'gpt-5.6-luna',
  add column if not exists codex_verification_model text not null default 'gpt-5.6-terra',
  add column if not exists codex_fast_model_slots jsonb not null
    default '["artifact", "artifactInteractive", "drafting", "structure"]'::jsonb,
  add column if not exists structure_reasoning_effort text not null default 'medium'
    check (structure_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  add column if not exists drafting_reasoning_effort text not null default 'high'
    check (drafting_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  add column if not exists verification_reasoning_effort text not null default 'high'
    check (verification_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high'));
