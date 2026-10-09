-- Configurable models for lesson scenes: scene composition, icon choice, and icon embeddings.
alter table public.model_config
  add column if not exists scene_model text not null default 'openai/gpt-6-luna',
  add column if not exists scene_reasoning_effort text not null default 'low'
    check (scene_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  add column if not exists codex_scene_model text not null default 'gpt-6-luna',
  add column if not exists openai_scene_model text not null default 'gpt-6-luna',
  add column if not exists scene_icon_model text not null default 'openai/gpt-6-luna',
  add column if not exists scene_icon_reasoning_effort text not null default 'none'
    check (scene_icon_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  add column if not exists codex_scene_icon_model text not null default 'gpt-6-luna',
  add column if not exists openai_scene_icon_model text not null default 'gpt-6-luna',
  add column if not exists embedding_model text not null default 'google/gemini-embedding-2';
