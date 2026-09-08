create table public.account_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null check (jsonb_typeof(preferences) = 'object')
);

alter table public.account_preferences enable row level security;
revoke all on public.account_preferences from anon, authenticated;
grant select, insert, update, delete on public.account_preferences to authenticated;
grant all on public.account_preferences to service_role;

create policy account_preferences_select on public.account_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy account_preferences_insert on public.account_preferences
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy account_preferences_update on public.account_preferences
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy account_preferences_delete on public.account_preferences
  for delete to authenticated using ((select auth.uid()) = user_id);
