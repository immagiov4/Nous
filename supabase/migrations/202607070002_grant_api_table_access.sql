grant select, insert, update, delete
  on public.profiles,
     public.projects,
     public.project_snapshots,
     public.library_folders,
     public.library_placements
  to authenticated, service_role;

grant select
  on public.model_config
  to authenticated, service_role;

grant insert, update, delete
  on public.model_config
  to service_role;
