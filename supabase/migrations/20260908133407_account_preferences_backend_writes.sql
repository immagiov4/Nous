-- The account API validates the complete preference schema before persistence.
revoke insert, update, delete on public.account_preferences from authenticated;

drop policy account_preferences_insert on public.account_preferences;
drop policy account_preferences_update on public.account_preferences;
drop policy account_preferences_delete on public.account_preferences;
