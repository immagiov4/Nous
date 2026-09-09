create table public.account_setup (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'completed', 'skipped'))
);
alter table public.account_setup enable row level security;
revoke all on public.account_setup from anon, authenticated;
grant all on public.account_setup to service_role;

-- Only accounts created after this migration enter the automatic initial setup.
-- Existing accounts deliberately have no row and can open setup from settings.
create function public.initialize_account_setup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.account_setup(user_id) values (new.id);
  return new;
end;
$$;
revoke all on function public.initialize_account_setup() from public, anon, authenticated;
create trigger initialize_account_setup
after insert on auth.users for each row execute function public.initialize_account_setup();
