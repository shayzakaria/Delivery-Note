-- Same as delivery_history_for_docs, plus who recorded each batch, so the
-- "document already reported" warning can name the user. Added alongside the
-- original (kept for clients still running the previous version).
create function public.delivery_history_with_reporter(p_docs text[])
returns table (
  doc_number text, po text, line_no integer, sku text, qty numeric, price numeric,
  batch_id uuid, created_at timestamptz, created_by_email text
)
language sql
stable
set search_path = ''
as $$
  select l.doc_number, l.po, l.line_no, l.sku, l.qty, l.price, b.id, b.created_at, b.created_by_email
  from public.export_doc_lines l
  join public.export_batches b on b.id = l.batch_id
  where b.kind = 'delivery'
    and l.doc_number = any (p_docs)
  order by b.created_at, l.id
$$;
revoke execute on function public.delivery_history_with_reporter(text[]) from public, anon;
grant execute on function public.delivery_history_with_reporter(text[]) to authenticated;
