alter table public.model_config
  add column if not exists lesson_reasoning_effort text not null default 'medium'
    check (lesson_reasoning_effort in ('none', 'low', 'medium', 'high')),
  add column if not exists context_reasoning_effort text not null default 'medium'
    check (context_reasoning_effort in ('none', 'low', 'medium', 'high')),
  add column if not exists assessment_reasoning_effort text not null default 'medium'
    check (assessment_reasoning_effort in ('none', 'low', 'medium', 'high'));
