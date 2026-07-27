alter table public.model_config
  alter column artifact_model set default 'deepseek/deepseek-v4-pro',
  alter column artifact_interactive_model set default 'openai/gpt-5.6-terra',
  alter column artifact_reasoning_effort set default 'none',
  alter column artifact_interactive_reasoning_effort set default 'low',
  alter column lesson_model set default 'openai/gpt-5.6-luna',
  alter column lesson_reasoning_effort set default 'high',
  alter column codex_artifact_model set default 'gpt-5.6-sol',
  alter column codex_artifact_interactive_model set default 'gpt-5.6-sol';
