-- Admin analytics: one call returning everything the admin dashboard shows.
-- Admins only: for anyone else it returns null, and the function is not even
-- callable by anonymous visitors.
create function private.admin_analytics()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if private.member_role() is distinct from 'admin' then
    return null;
  end if;

  with
  acct as (
    select lower(u.email) as email, u.id, u.last_sign_in_at
    from auth.users u
    where u.deleted_at is null
  ),
  last_export as (
    select created_by_email as email, max(created_at) as at from public.export_batches group by 1
  ),
  last_import as (
    select created_by_email as email, max(created_at) as at from public.po_imports group by 1
  ),
  open_drafts as (
    select d.user_id, count(*) as n, max(d.updated_at) as last_at, min(d.updated_at) as oldest_at
    from public.drafts d
    where d.items <> '{}'::jsonb
    group by d.user_id
  ),
  users as (
    select jsonb_agg(jsonb_build_object(
             'email', m.email,
             'display_name', m.display_name,
             'role', m.role,
             'registered', a.id is not null,
             'last_sign_in_at', a.last_sign_in_at,
             'last_export_at', le.at,
             'last_import_at', li.at,
             'last_draft_at', od.last_at,
             'open_drafts', coalesce(od.n, 0)
           ) order by m.email) as v
    from public.app_members m
    left join acct a on a.email = m.email
    left join last_export le on lower(le.email) = m.email
    left join last_import li on lower(li.email) = m.email
    left join open_drafts od on od.user_id = a.id
  ),
  batches as (
    select jsonb_agg(jsonb_build_object(
             'kind', b.kind, 'created_at', b.created_at, 'email', b.created_by_email,
             'lines', b.line_count, 'value', b.total_value
           ) order by b.created_at) as v
    from public.export_batches b
    where b.created_at > now() - interval '400 days'
  ),
  imports as (
    select jsonb_agg(x.j order by x.created_at desc) as v
    from (
      select i.created_at, jsonb_build_object(
               'created_at', i.created_at, 'email', i.created_by_email, 'file_name', i.file_name,
               'file_modified_at', i.file_modified_at, 'rows', i.row_count, 'pos', i.po_count) as j
      from public.po_imports i
      order by i.created_at desc
      limit 10
    ) x
  ),
  doc_reports as (
    select l.doc_number, b.id as batch_id, b.created_at, b.created_by_email as email,
           array_agg(distinct l.po order by l.po) as pos, count(*) as lines
    from public.export_doc_lines l
    join public.export_batches b on b.id = l.batch_id
    where b.kind = 'delivery'
    group by l.doc_number, b.id, b.created_at, b.created_by_email
  ),
  dup_docs as (
    select jsonb_agg(jsonb_build_object('doc_number', g.doc_number, 'reports', g.reports) order by g.last_at desc) as v
    from (
      select doc_number,
             max(created_at) as last_at,
             jsonb_agg(jsonb_build_object('created_at', created_at, 'email', email, 'pos', to_jsonb(pos), 'lines', lines)
                       order by created_at) as reports
      from doc_reports
      group by doc_number
      having count(*) > 1
    ) g
  ),
  stale as (
    select jsonb_agg(jsonb_build_object(
             'email', a.email, 'kind', d.kind, 'po', d.po, 'doc_number', d.doc_number,
             'updated_at', d.updated_at,
             'items', (select count(*) from jsonb_object_keys(d.items))
           ) order by d.updated_at) as v
    from public.drafts d
    left join acct a on a.id = d.user_id
    where d.items <> '{}'::jsonb
  )
  select jsonb_build_object(
           'generated_at', now(),
           'users', coalesce((select v from users), '[]'::jsonb),
           'batches', coalesce((select v from batches), '[]'::jsonb),
           'imports', coalesce((select v from imports), '[]'::jsonb),
           'duplicate_docs', coalesce((select v from dup_docs), '[]'::jsonb),
           'open_drafts', coalesce((select v from stale), '[]'::jsonb)
         )
  into result;
  return result;
end
$$;
revoke all on function private.admin_analytics() from public, anon;
grant execute on function private.admin_analytics() to authenticated;

create function public.admin_analytics()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.admin_analytics() $$;
revoke all on function public.admin_analytics() from public, anon;
grant execute on function public.admin_analytics() to authenticated;
