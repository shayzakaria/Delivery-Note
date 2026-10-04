-- Self sign-up, restricted to the app_members list.
-- An account can only be created (or have its email changed) for an email an
-- admin has already put on app_members. Removing an email from the list still
-- revokes access immediately (see private.member_role()).

create or replace function private.enforce_signup_allowlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.email is not distinct from old.email then
    return new;
  end if;
  if new.email is null
     or not exists (select 1 from public.app_members m where m.email = lower(btrim(new.email))) then
    raise exception 'EMAIL_NOT_ALLOWED: % is not on the allowed list', new.email using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.enforce_signup_allowlist() from public, anon, authenticated;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.enforce_signup_allowlist() to supabase_auth_admin;

create trigger enforce_signup_allowlist
before insert or update of email on auth.users
for each row execute function private.enforce_signup_allowlist();

