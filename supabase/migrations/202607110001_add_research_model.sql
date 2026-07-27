alter table public.model_config
  add column if not exists research_model text not null default 'perplexity/sonar-pro-search';
