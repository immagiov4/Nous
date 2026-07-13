alter table public.model_config
  add column if not exists artifact_interactive_model text,
  add column if not exists artifact_interactive_reasoning_effort text,
  add column if not exists codex_artifact_interactive_model text,
  add column if not exists openai_artifact_interactive_model text;

update public.model_config
set
  artifact_interactive_model = coalesce(artifact_interactive_model, artifact_model),
  artifact_interactive_reasoning_effort = coalesce(
    artifact_interactive_reasoning_effort,
    artifact_reasoning_effort
  ),
  codex_artifact_interactive_model = coalesce(
    codex_artifact_interactive_model,
    codex_artifact_model
  ),
  openai_artifact_interactive_model = coalesce(
    openai_artifact_interactive_model,
    openai_artifact_model
  );

alter table public.model_config
  alter column artifact_interactive_model set default 'openai/gpt-5.4-mini',
  alter column artifact_interactive_model set not null,
  alter column artifact_interactive_reasoning_effort set default 'medium',
  alter column artifact_interactive_reasoning_effort set not null,
  alter column codex_artifact_interactive_model set default 'gpt-5.6-terra',
  alter column codex_artifact_interactive_model set not null,
  alter column openai_artifact_interactive_model set default 'gpt-5.6-terra',
  alter column openai_artifact_interactive_model set not null;

alter table public.model_config
  add constraint model_config_artifact_interactive_reasoning_effort_check
  check (artifact_interactive_reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high'));
