alter table public.model_config
  add column if not exists image_model text not null
  default 'google/gemini-3.1-flash-lite-image';
