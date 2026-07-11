alter table public.model_config
  add column if not exists progress_model text not null default 'google/gemini-3.1-flash-lite',
  add column if not exists progress_reasoning_effort text not null default 'low'
    check (progress_reasoning_effort in ('none', 'low', 'medium', 'high'));
