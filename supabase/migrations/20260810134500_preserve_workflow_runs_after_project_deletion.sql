alter table public.workflow_runs
  drop constraint workflow_runs_user_id_project_id_fkey;

alter table public.workflow_runs
  add constraint workflow_runs_user_id_project_id_fkey
  foreign key (user_id, project_id)
  references public.projects(user_id, id)
  on delete set null (project_id);
