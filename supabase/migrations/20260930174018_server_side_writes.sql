-- Writes to history and open-order imports go only through the RPCs.
--
-- Before: record_export / import_open_orders ran as SECURITY INVOKER, so members
-- needed INSERT on the child tables — which also let them append rows to another
-- user's existing export batch through the REST API (forging order-line numbers
-- used by invoice reconciliation). Now the RPCs run as SECURITY DEFINER helpers in
-- the private schema (not exposed by the API), validate their input, and the API
-- roles lose direct INSERT/DELETE on these tables.

-- ---------------------------------------------------------------------
-- record_export
-- ---------------------------------------------------------------------
create or replace function private.record_export(
  p_kind text,
  p_file_name text,
  p_csv text,
  p_total numeric,
  p_pdf_names text[],
  p_meta jsonb,
  p_doc_lines jsonb,
  p_invoice_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_count integer;
  v_bad   integer;
begin
  if not public.is_member() then
    raise exception 'אין הרשאה' using errcode = '42501';
  end if;
  if p_kind not in ('delivery', 'invoice_manual', 'invoice_match') then
    raise exception 'סוג ייצוא לא חוקי' using errcode = '22023';
  end if;
  if coalesce(length(p_csv), 0) > 5000000 or coalesce(length(p_file_name), 0) not between 1 and 200 then
    raise exception 'ייצוא חורג מהגבלות הגודל' using errcode = '22023';
  end if;

  if p_kind = 'invoice_match' then
    if coalesce(jsonb_typeof(p_invoice_lines), '') <> 'array' or coalesce(jsonb_typeof(p_doc_lines), '') = 'array' then
      raise exception 'שורות לא תואמות לסוג הייצוא' using errcode = '22023';
    end if;
    v_count := jsonb_array_length(p_invoice_lines);
    select count(*) into v_bad
    from jsonb_to_recordset(p_invoice_lines) as r (inv_no text, dn text, sku text, qty numeric, price numeric)
    where coalesce(btrim(r.inv_no), '') = '' or coalesce(btrim(r.dn), '') = '' or r.sku is null or r.qty is null or r.price is null;
  else
    if coalesce(jsonb_typeof(p_doc_lines), '') <> 'array' or coalesce(jsonb_typeof(p_invoice_lines), '') = 'array' then
      raise exception 'שורות לא תואמות לסוג הייצוא' using errcode = '22023';
    end if;
    v_count := jsonb_array_length(p_doc_lines);
    select count(*) into v_bad
    from jsonb_to_recordset(p_doc_lines) as r (doc_number text, po text, line_no integer, sku text, qty numeric, price numeric)
    where coalesce(btrim(r.doc_number), '') = '' or r.doc_number ~ '[,"\r\n]'
       or coalesce(btrim(r.po), '') = '' or r.line_no is null or r.line_no < 1
       or r.sku is null or r.qty is null or r.qty <= 0 or r.price is null;
  end if;

  if v_count = 0 or v_count > 20000 then
    raise exception 'מספר שורות לא חוקי' using errcode = '22023';
  end if;
  if v_bad > 0 then
    raise exception 'שורות לא תקינות בייצוא (%)', v_bad using errcode = '22023';
  end if;

  insert into public.export_batches (kind, file_name, csv_content, line_count, total_value, pdf_names, meta)
  values (p_kind, p_file_name, p_csv, v_count, coalesce(p_total, 0), coalesce(p_pdf_names, '{}'), coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;

  if p_kind = 'invoice_match' then
    insert into public.export_invoice_lines (batch_id, inv_no, alloc, site_code, inv_date, sku, qty, price, dn, po, line_no)
    select v_id, r.inv_no, r.alloc, r.site_code, r.inv_date, r.sku, r.qty, r.price, r.dn, r.po, r.line_no
    from jsonb_to_recordset(p_invoice_lines) as r (
      inv_no text, alloc text, site_code text, inv_date text, sku text,
      qty numeric, price numeric, dn text, po text, line_no text
    );
  else
    insert into public.export_doc_lines (batch_id, doc_number, doc_date, site_code, po, line_no, sku, item_desc, qty, price)
    select v_id, btrim(r.doc_number), r.doc_date, r.site_code, r.po, r.line_no, r.sku, r.item_desc, r.qty, r.price
    from jsonb_to_recordset(p_doc_lines) as r (
      doc_number text, doc_date date, site_code bigint, po text, line_no integer,
      sku text, item_desc text, qty numeric, price numeric
    );
  end if;

  return v_id;
end
$$;

-- ---------------------------------------------------------------------
-- import_open_orders
-- ---------------------------------------------------------------------
create or replace function private.import_open_orders(
  p_file_name text,
  p_file_modified_at timestamptz,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_rows integer;
  v_pos  integer;
begin
  if not public.is_member() then
    raise exception 'אין הרשאה' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'הקובץ אינו מכיל שורות' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 100000 or coalesce(length(p_file_name), 0) not between 1 and 300 then
    raise exception 'הקובץ חורג מהגבלות הגודל' using errcode = '22023';
  end if;

  select count(*), count(distinct x ->> 'po')
    into v_rows, v_pos
    from jsonb_array_elements(p_lines) x;

  insert into public.po_imports (file_name, file_modified_at, row_count, po_count)
  values (p_file_name, p_file_modified_at, v_rows, v_pos)
  returning id into v_id;

  insert into public.po_lines (
    import_id, po, line_no, site_code, site_name, order_date, po_desc, buyer,
    sku, item_desc, qty_ordered, balance, price, line_total
  )
  select v_id, r.po, r.line_no, r.site_code, coalesce(r.site_name, ''), r.order_date,
         coalesce(r.po_desc, ''), coalesce(r.buyer, ''), r.sku, coalesce(r.item_desc, ''),
         coalesce(r.qty_ordered, 0), r.balance, coalesce(r.price, 0), coalesce(r.line_total, 0)
  from jsonb_to_recordset(p_lines) as r (
    po text, line_no integer, site_code bigint, site_name text, order_date date,
    po_desc text, buyer text, sku text, item_desc text,
    qty_ordered numeric, balance numeric, price numeric, line_total numeric
  );

  -- keep the 20 most recent imports
  delete from public.po_imports
  where id in (
    select id from public.po_imports order by created_at desc, id offset 20
  );

  return v_id;
end
$$;

revoke all on function
  private.record_export(text, text, text, numeric, text[], jsonb, jsonb, jsonb),
  private.import_open_orders(text, timestamptz, jsonb)
  from public, anon;
grant execute on function
  private.record_export(text, text, text, numeric, text[], jsonb, jsonb, jsonb),
  private.import_open_orders(text, timestamptz, jsonb)
  to authenticated;

-- Public API: thin SECURITY INVOKER wrappers (same signatures as before).
create or replace function public.record_export(
  p_kind text, p_file_name text, p_csv text, p_total numeric, p_pdf_names text[],
  p_meta jsonb, p_doc_lines jsonb, p_invoice_lines jsonb
)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.record_export(p_kind, p_file_name, p_csv, p_total, p_pdf_names, p_meta, p_doc_lines, p_invoice_lines) $$;

create or replace function public.import_open_orders(p_file_name text, p_file_modified_at timestamptz, p_lines jsonb)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.import_open_orders(p_file_name, p_file_modified_at, p_lines) $$;

-- ---------------------------------------------------------------------
-- No direct writes from the API roles.
-- ---------------------------------------------------------------------
drop policy if exists po_imports_insert on public.po_imports;
drop policy if exists po_imports_delete on public.po_imports;
drop policy if exists po_lines_insert on public.po_lines;
drop policy if exists export_batches_insert on public.export_batches;
drop policy if exists export_doc_lines_insert on public.export_doc_lines;
drop policy if exists export_invoice_lines_insert on public.export_invoice_lines;

revoke insert, delete on public.po_imports from authenticated;
revoke insert on public.po_lines, public.export_batches, public.export_doc_lines, public.export_invoice_lines from authenticated;

-- ---------------------------------------------------------------------
-- Last-admin guard: count only admins who can actually sign in, and
-- serialize concurrent membership changes.
-- ---------------------------------------------------------------------
create or replace function private.usable_admin_count(p_exclude text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.app_members m
  join auth.users u on lower(u.email) = m.email
  where m.role = 'admin'
    and m.email <> coalesce(p_exclude, '')
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until < now())
$$;

create or replace function private.is_usable_account(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where lower(u.email) = lower(p_email)
      and u.email_confirmed_at is not null
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until < now())
  )
$$;

revoke all on function private.usable_admin_count(text), private.is_usable_account(text) from public, anon;
grant execute on function private.usable_admin_count(text), private.is_usable_account(text) to authenticated;

create or replace function public.app_members_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.email := lower(btrim(new.email));
    return new;
  end if;

  if tg_op = 'UPDATE' and new.email is distinct from old.email then
    raise exception 'לא ניתן לשנות כתובת מייל של משתמש קיים' using errcode = '22023';
  end if;

  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    -- One membership change at a time, so two admins cannot demote each other at once.
    perform pg_advisory_xact_lock(hashtext('public.app_members.admin_guard'));
    -- Removing an admin who can sign in must leave at least one other such admin.
    if private.is_usable_account(old.email) and private.usable_admin_count(old.email) = 0 then
      raise exception 'לא ניתן להסיר את המנהל האחרון' using errcode = '22023';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;
