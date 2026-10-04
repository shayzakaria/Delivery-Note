-- Admin view of each listed email's account: none / unconfirmed / active.
create or replace function private.member_accounts()
returns table (email text, account_status text, last_sign_in_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.email,
         case when u.id is null then 'none'
              when u.email_confirmed_at is null then 'unconfirmed'
              else 'active' end,
         u.last_sign_in_at
  from public.app_members m
  left join auth.users u on lower(u.email) = m.email and u.deleted_at is null
  where private.member_role() = 'admin'
$$;
revoke all on function private.member_accounts() from public, anon;
grant execute on function private.member_accounts() to authenticated;

create or replace function public.member_accounts()
returns table (email text, account_status text, last_sign_in_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.member_accounts() $$;
revoke all on function public.member_accounts() from public, anon;
grant execute on function public.member_accounts() to authenticated;
