insert into storage.buckets (id, name, public)
values ('project-sources', 'project-sources', false)
on conflict (id) do update set public = false;
