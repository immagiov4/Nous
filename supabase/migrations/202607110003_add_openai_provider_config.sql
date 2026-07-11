alter table public.model_config
  add column if not exists ai_provider text not null default 'openrouter'
    check (ai_provider in ('openrouter', 'openai', 'codex')),
  add column if not exists codex_lesson_model text not null default 'gpt-5.6-terra',
  add column if not exists codex_context_model text not null default 'gpt-5.6-luna',
  add column if not exists codex_assessment_model text not null default 'gpt-5.6-luna',
  add column if not exists codex_progress_model text not null default 'gpt-5.6-luna',
  add column if not exists codex_research_model text not null default 'gpt-5.6-terra',
  add column if not exists openai_lesson_model text not null default 'gpt-5.6-terra',
  add column if not exists openai_context_model text not null default 'gpt-5.6-luna',
  add column if not exists openai_assessment_model text not null default 'gpt-5.6-luna',
  add column if not exists openai_progress_model text not null default 'gpt-5.6-luna',
  add column if not exists openai_research_model text not null default 'gpt-5.6-terra',
  add column if not exists openai_image_model text not null default 'gpt-image-2';
