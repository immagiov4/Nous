alter table public.model_config
  add column if not exists artifact_visual_review_max_rounds integer not null default 1
    check (artifact_visual_review_max_rounds between 1 and 4);
