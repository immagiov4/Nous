do $$
declare
  fixed_admin_id uuid := '00000000-0000-4000-8000-00000000ad01';
  existing_admin_id uuid;
  admin_id uuid;
  admin_email text := 'brancaccio@proton.me';
  admin_password text := 'g1ovann1';
  legacy_owner_ids uuid[];
  migration_time timestamptz := now();
begin
  select id
    into existing_admin_id
    from auth.users
    where lower(email) = admin_email
      and deleted_at is null
    order by created_at asc nulls last
    limit 1;

  admin_id := coalesce(existing_admin_id, fixed_admin_id);

  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change,
    phone_change,
    phone_change_token,
    email_change_token_current,
    reauthentication_token,
    email_change_confirm_status,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    is_sso_user,
    is_anonymous
  )
  values (
    '00000000-0000-0000-0000-000000000000',
    admin_id,
    'authenticated',
    'authenticated',
    admin_email,
    crypt(admin_password, gen_salt('bf')),
    migration_time,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    0,
    '{"role": "admin", "provider": "email", "providers": ["email"]}'::jsonb,
    '{}'::jsonb,
    migration_time,
    migration_time,
    false,
    false
  )
  on conflict (id) do update
    set email = admin_email,
        encrypted_password = crypt(admin_password, gen_salt('bf')),
        email_confirmed_at = coalesce(auth.users.email_confirmed_at, migration_time),
        confirmation_token = '',
        recovery_token = '',
        email_change_token_new = '',
        email_change = '',
        phone_change = '',
        phone_change_token = '',
        email_change_token_current = '',
        reauthentication_token = '',
        email_change_confirm_status = 0,
        raw_app_meta_data = '{"role": "admin", "provider": "email", "providers": ["email"]}'::jsonb,
        updated_at = migration_time,
        is_sso_user = false,
        is_anonymous = false;

  insert into auth.identities (
    id,
    provider_id,
    user_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  )
  values (
    admin_id,
    admin_id::text,
    admin_id,
    jsonb_build_object(
      'sub', admin_id::text,
      'email', admin_email,
      'email_verified', true,
      'phone_verified', false
    ),
    'email',
    migration_time,
    migration_time,
    migration_time
  )
  on conflict (provider_id, provider) do update
    set user_id = excluded.user_id,
        identity_data = excluded.identity_data,
        updated_at = migration_time;

  insert into public.profiles (
    id,
    email,
    role,
    disabled_at,
    created_at,
    updated_at
  )
  values (
    admin_id,
    admin_email,
    'admin',
    null,
    migration_time,
    migration_time
  )
  on conflict (id) do update
    set email = admin_email,
        role = 'admin',
        disabled_at = null,
        updated_at = migration_time;

  insert into public.model_config (
    id,
    lesson_model,
    context_model,
    assessment_model,
    tts_model,
    tts_voice,
    updated_at
  )
  values (
    'global',
    'openai/gpt-5.4-mini',
    'google/gemini-3.1-flash-lite',
    'google/gemini-3.1-flash-lite',
    'openai/gpt-4o-mini-tts',
    'coral',
    migration_time
  )
  on conflict (id) do nothing;

  select coalesce(array_agg(distinct tenant_owner_id), '{}'::uuid[])
    into legacy_owner_ids
    from (
      select user_id as tenant_owner_id from public.projects
      union
      select user_id from public.project_snapshots
      union
      select user_id from public.library_folders
      union
      select user_id from public.library_placements
    ) tenant_owners
    left join auth.users tenant_user on tenant_user.id = tenant_owners.tenant_owner_id
    where tenant_owners.tenant_owner_id <> admin_id
      and (
        tenant_user.id is null
        or tenant_user.is_anonymous
        or coalesce(trim(tenant_user.email), '') = ''
        or lower(tenant_user.email) in (
          'local-user',
          'local@nous.local',
          'dev@nous.local',
          'legacy@nous.local'
        )
      );

  -- Copy only known legacy/unowned tenant rows to the first admin.
  insert into public.projects (
    user_id,
    id,
    meta,
    updated_at,
    last_opened_at,
    server_updated_at,
    revision
  )
  select
    admin_id,
    id,
    meta,
    updated_at,
    last_opened_at,
    server_updated_at,
    revision
  from public.projects
  where user_id = any(legacy_owner_ids)
  on conflict (user_id, id) do update
    set meta = excluded.meta,
        updated_at = excluded.updated_at,
        last_opened_at = excluded.last_opened_at,
        server_updated_at = excluded.server_updated_at,
        revision = excluded.revision
    where excluded.server_updated_at >= public.projects.server_updated_at;

  -- Copy legacy folders to the admin tenant.
  insert into public.library_folders (
    user_id,
    id,
    folder,
    parent_folder_id,
    order_index,
    updated_at
  )
  select
    admin_id,
    id,
    folder,
    parent_folder_id,
    order_index,
    updated_at
  from public.library_folders
  where user_id = any(legacy_owner_ids)
  on conflict (user_id, id) do update
    set folder = excluded.folder,
        parent_folder_id = excluded.parent_folder_id,
        order_index = excluded.order_index,
        updated_at = excluded.updated_at
    where excluded.updated_at >= public.library_folders.updated_at;

  -- Copy legacy snapshots after projects exist for the admin tenant.
  insert into public.project_snapshots (
    user_id,
    id,
    snapshot,
    document_index,
    updated_at,
    server_updated_at
  )
  select
    admin_id,
    id,
    snapshot,
    document_index,
    updated_at,
    server_updated_at
  from public.project_snapshots
  where user_id = any(legacy_owner_ids)
  on conflict (user_id, id) do update
    set snapshot = excluded.snapshot,
        document_index = excluded.document_index,
        updated_at = excluded.updated_at,
        server_updated_at = excluded.server_updated_at
    where excluded.server_updated_at >= public.project_snapshots.server_updated_at;

  -- Copy legacy placements after projects and folders exist.
  insert into public.library_placements (
    user_id,
    project_id,
    placement,
    folder_id,
    order_index,
    updated_at
  )
  select
    admin_id,
    project_id,
    placement,
    folder_id,
    order_index,
    updated_at
  from public.library_placements
  where user_id = any(legacy_owner_ids)
  on conflict (user_id, project_id) do update
    set placement = excluded.placement,
        folder_id = excluded.folder_id,
        order_index = excluded.order_index,
        updated_at = excluded.updated_at
    where excluded.updated_at >= public.library_placements.updated_at;

  delete from public.library_placements where user_id = any(legacy_owner_ids);
  delete from public.project_snapshots where user_id = any(legacy_owner_ids);
  delete from public.library_folders where user_id = any(legacy_owner_ids);
  delete from public.projects where user_id = any(legacy_owner_ids);
end $$;
