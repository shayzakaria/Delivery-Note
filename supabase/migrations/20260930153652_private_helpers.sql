-- Move the SECURITY DEFINER helper out of the exposed API schema.
-- public.current_member_role() stays as a thin SECURITY INVOKER wrapper that
-- the client calls to decide whether to show the app or a "no access" screen.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.member_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from auth.users u
  join public.app_members m on m.email = lower(u.email)
  where u.id = auth.uid()
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until < now())
$$;
revoke execute on function private.member_role() from public, anon;
grant execute on function private.member_role() to authenticated;

create or replace function public.current_member_role()
returns text
language sql
stable
security invoker
set search_path = ''
as $$ select private.member_role() $$;

create or replace function public.is_member()
returns boolean
language sql
stable
set search_path = ''
as $$ select private.member_role() is not null $$;

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce(private.member_role() = 'admin', false) $$;

create index if not exists po_imports_created_by_idx on public.po_imports (created_by);
create index if not exists export_batches_created_by_idx on public.export_batches (created_by);
