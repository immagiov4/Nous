create table if not exists public.project_source_storage_stage (
  user_id uuid not null,
  project_id text not null,
  migration_kind text not null
    check (migration_kind in ('project-source-row', 'embedded-source-set', 'historical-codebase')),
  source_id text not null,
  source_hash text not null,
  name text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  object_path text not null,
  staged_snapshot jsonb,
  source_files jsonb not null default '[]'::jsonb,
  staged_at timestamptz not null default now(),
  primary key (user_id, project_id),
  unique (object_path),
  foreign key (user_id, project_id)
    references public.project_snapshots(user_id, id) on delete cascade,
  check (migration_kind <> 'historical-codebase' or staged_snapshot is not null),
  check (jsonb_array_length(source_files) > 0),
  check (jsonb_typeof(source_files) = 'array')
);

alter table public.project_source_storage_stage enable row level security;
revoke all on public.project_source_storage_stage from anon, authenticated;

do $$
begin
  if exists (
    select 1
    from public.project_snapshots project
    where project.snapshot #>> '{source,kind}' = 'codebase-bundle'
      and (
        case
          when project.snapshot #> '{source,files}' is null
            or project.snapshot #> '{source,files}' = 'null'::jsonb then false
          when jsonb_typeof(project.snapshot #> '{source,files}') = 'array'
            then jsonb_array_length(project.snapshot #> '{source,files}') > 0
          else true
        end
        or case
          when project.snapshot #> '{source,sources}' is null
            or project.snapshot #> '{source,sources}' = 'null'::jsonb then false
          when jsonb_typeof(project.snapshot #> '{source,sources}') = 'array'
            then jsonb_array_length(project.snapshot #> '{source,sources}') > 0
          else true
        end
      )
  ) then
    raise exception
      'Project source Storage cutover refused: historical bundle contains unexpanded files.';
  end if;

  if exists (
    select 1
    from public.project_sources source
    where not exists (
      select 1
      from public.project_source_storage_stage stage
      where stage.user_id = source.user_id
        and stage.project_id = source.project_id
    )
  ) then
    raise exception
      'Project source Storage cutover refused: legacy source rows were not staged.';
  end if;

  if exists (
    select 1
    from public.project_snapshots project
    where (
      coalesce(project.snapshot #>> '{source,file,data}', '') <> ''
      or exists (
        select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(project.snapshot #> '{source,sources}') = 'array'
              then project.snapshot #> '{source,sources}'
            else '[]'::jsonb
          end
        ) descriptor
        where coalesce(descriptor #>> '{file,data}', '') <> ''
      )
      or (
        project.snapshot #>> '{source,kind}' = 'codebase-bundle'
        and coalesce(project.snapshot #>> '{source,aggregatedText}', '') <> ''
      )
    )
    and not exists (
      select 1
      from public.project_source_storage_stage stage
      where stage.user_id = project.user_id
        and stage.project_id = project.id
    )
  ) then
    raise exception
      'Project source Storage cutover refused: embedded source bytes were not staged.';
  end if;
end
$$;

alter table public.project_sources rename to project_sources_legacy;

create table public.project_sources (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  source_id text not null,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  name text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  object_path text not null unique,
  source_kind text not null check (source_kind in ('archive', 'file')),
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id),
  foreign key (user_id, project_id)
    references public.projects(user_id, id) on delete cascade
);

create table public.project_source_entries (
  user_id uuid not null,
  project_id text not null,
  path text not null,
  kind text not null check (kind in ('directory', 'file')),
  content_kind text check (content_kind in ('binary', 'text')),
  source_hash text check (source_hash is null or source_hash ~ '^[0-9a-f]{64}$'),
  byte_size bigint check (byte_size is null or byte_size >= 0),
  preview text,
  object_path text unique,
  primary key (user_id, project_id, path),
  foreign key (user_id, project_id)
    references public.project_sources(user_id, project_id) on delete cascade,
  check (
    (kind = 'directory'
      and content_kind is null
      and source_hash is null
      and byte_size is null
      and preview is null
      and object_path is null)
    or
    (kind = 'file'
      and content_kind is not null
      and source_hash is not null
      and byte_size is not null
      and object_path is not null)
  ),
  check (position(chr(0) in path) = 0)
);

create table public.project_source_files (
  user_id uuid not null,
  project_id text not null,
  source_id text not null,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  name text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  object_path text not null unique,
  position integer not null check (position >= 0),
  primary key (user_id, project_id, source_id),
  foreign key (user_id, project_id)
    references public.project_sources(user_id, project_id) on delete cascade,
  unique (user_id, project_id, position)
);

create table public.project_source_deletions (
  object_path text primary key,
  created_at timestamptz not null default now()
);

insert into public.project_sources (
  user_id,
  project_id,
  source_id,
  source_hash,
  name,
  mime_type,
  byte_size,
  object_path,
  source_kind,
  updated_at
)
select
  stage.user_id,
  stage.project_id,
  stage.source_id,
  stage.source_hash,
  stage.name,
  stage.mime_type,
  stage.byte_size,
  stage.object_path,
  'file',
  stage.staged_at
from public.project_source_storage_stage stage;

insert into public.project_source_files (
  user_id,
  project_id,
  source_id,
  source_hash,
  name,
  mime_type,
  byte_size,
  object_path,
  position
)
select
  stage.user_id,
  stage.project_id,
  source_file ->> 'sourceId',
  source_file ->> 'sourceHash',
  source_file ->> 'name',
  source_file ->> 'mimeType',
  (source_file ->> 'byteSize')::bigint,
  source_file ->> 'objectPath',
  (source_file ->> 'position')::integer
from public.project_source_storage_stage stage
cross join lateral jsonb_array_elements(stage.source_files) source_file;

update public.project_snapshots project
set snapshot = stage.staged_snapshot,
    server_updated_at = now()
from public.project_source_storage_stage stage
where stage.user_id = project.user_id
  and stage.project_id = project.id
  and stage.staged_snapshot is not null;

do $$
begin
  if (
    select count(*) from public.project_sources
  ) <> (
    select count(*) from public.project_source_storage_stage
  ) then
    raise exception
      'Project source Storage cutover refused: staged metadata count mismatch.';
  end if;

  if (
    select count(*) from public.project_source_files
  ) <> (
    select coalesce(sum(jsonb_array_length(source_files)), 0)
    from public.project_source_storage_stage
  ) then
    raise exception
      'Project source Storage cutover refused: staged source file count mismatch.';
  end if;

  if exists (
    select 1
    from public.project_snapshots project
    where coalesce(project.snapshot #>> '{source,file,data}', '') <> ''
      or exists (
        select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(project.snapshot #> '{source,sources}') = 'array'
              then project.snapshot #> '{source,sources}'
            else '[]'::jsonb
          end
        ) descriptor
        where coalesce(descriptor #>> '{file,data}', '') <> ''
      )
      or coalesce(project.snapshot #>> '{source,aggregatedText}', '') <> ''
  ) then
    raise exception
      'Project source Storage cutover refused: embedded source bytes remain.';
  end if;
end
$$;

drop table public.project_sources_legacy;
drop table public.project_source_storage_stage;

alter table public.project_sources enable row level security;
alter table public.project_source_entries enable row level security;
alter table public.project_source_files enable row level security;
alter table public.project_source_deletions enable row level security;

revoke all on public.project_sources from anon, authenticated;
revoke all on public.project_source_entries from anon, authenticated;
revoke all on public.project_source_files from anon, authenticated;
revoke all on public.project_source_deletions from anon, authenticated;

grant select, insert, update, delete on public.project_sources to service_role;
grant select, insert, update, delete on public.project_source_entries to service_role;
grant select, insert, update, delete on public.project_source_files to service_role;
grant select, insert, update, delete on public.project_source_deletions to service_role;
