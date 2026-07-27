alter table public.model_config
  add column course_model text,
  add column codex_course_model text,
  add column openai_course_model text,
  add column course_reasoning_effort text;

update public.model_config
set
  course_model = lesson_model,
  codex_course_model = codex_structure_model,
  openai_course_model = openai_lesson_model,
  course_reasoning_effort = structure_reasoning_effort,
  ai_provider_overrides =
    (ai_provider_overrides - 'drafting' - 'structure' - 'verification')
    || case
      when ai_provider_overrides ? 'structure'
        then jsonb_build_object('course', ai_provider_overrides -> 'structure')
      else '{}'::jsonb
    end,
  codex_fast_model_slots = to_jsonb(array_remove(array[
    case when codex_fast_model_slots ? 'artifact' then 'artifact' end,
    case when codex_fast_model_slots ? 'artifactInteractive' then 'artifactInteractive' end,
    case when codex_fast_model_slots ? 'assessment' then 'assessment' end,
    case when codex_fast_model_slots ? 'context' then 'context' end,
    case
      when codex_fast_model_slots ? 'course' or codex_fast_model_slots ? 'structure'
        then 'course'
    end,
    case
      when codex_fast_model_slots ? 'lesson'
        or codex_fast_model_slots ? 'drafting'
        or codex_fast_model_slots ? 'verification'
        then 'lesson'
    end,
    case when codex_fast_model_slots ? 'progress' then 'progress' end,
    case when codex_fast_model_slots ? 'research' then 'research' end
  ], null));

alter table public.model_config
  alter column course_model set not null,
  alter column course_model set default 'openai/gpt-5.6-luna',
  alter column codex_course_model set not null,
  alter column codex_course_model set default 'gpt-5.6-luna',
  alter column openai_course_model set not null,
  alter column openai_course_model set default 'gpt-5.6-terra',
  alter column course_reasoning_effort set not null,
  alter column course_reasoning_effort set default 'medium',
  add constraint model_config_course_reasoning_effort_check
    check (course_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high')),
  drop column codex_structure_model,
  drop column codex_drafting_model,
  drop column codex_verification_model,
  drop column structure_reasoning_effort,
  drop column drafting_reasoning_effort,
  drop column verification_reasoning_effort;
