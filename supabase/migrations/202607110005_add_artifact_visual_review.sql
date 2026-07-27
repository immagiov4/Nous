alter table public.model_config
  add column if not exists artifact_visual_review_enabled boolean not null default true;
