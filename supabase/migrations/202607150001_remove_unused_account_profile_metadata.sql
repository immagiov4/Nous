-- Nous accounts do not use personal display names or avatars. Keep these
-- provider claims out of the application-owned auth user metadata.
create or replace function public.strip_unused_account_profile_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb)
    - 'avatar_url'
    - 'display_name'
    - 'full_name'
    - 'name'
    - 'picture';
  return new;
end;
$$;

update auth.users
set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
  - 'avatar_url'
  - 'display_name'
  - 'full_name'
  - 'name'
  - 'picture'
where coalesce(raw_user_meta_data, '{}'::jsonb) ?| array[
  'avatar_url',
  'display_name',
  'full_name',
  'name',
  'picture'
];

drop trigger if exists strip_unused_account_profile_metadata on auth.users;
create trigger strip_unused_account_profile_metadata
before insert or update of raw_user_meta_data on auth.users
for each row execute function public.strip_unused_account_profile_metadata();
