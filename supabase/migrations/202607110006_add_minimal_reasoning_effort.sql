alter table public.model_config
  drop constraint if exists model_config_artifact_reasoning_effort_check,
  drop constraint if exists model_config_assessment_reasoning_effort_check,
  drop constraint if exists model_config_context_reasoning_effort_check,
  drop constraint if exists model_config_lesson_reasoning_effort_check,
  drop constraint if exists model_config_progress_reasoning_effort_check;

alter table public.model_config
  add check (artifact_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  add check (assessment_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  add check (context_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  add check (lesson_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  add check (progress_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high'));
