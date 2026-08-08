alter table public.model_config
  add column if not exists research_reasoning_effort text not null default 'none'
    check (research_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high'));
