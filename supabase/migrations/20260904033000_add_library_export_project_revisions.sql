alter table public.projects
  add column incarnation_id uuid not null default gen_random_uuid();

alter table public.library_export_project_checkpoints
  add column project_revision bigint
    check (project_revision is null or project_revision >= 0),
  add column project_incarnation_id uuid;
