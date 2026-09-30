-- =====================================================================
-- Delivery Note (MODY → Shikun & Binui / Solel Boneh portal)
-- Core schema: members allowlist, open-order imports, per-user drafts,
-- immutable export history. Every table is protected by RLS and is only
-- visible to authenticated users whose (confirmed) email is in app_members.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Members allowlist
-- ---------------------------------------------------------------------
create table public.app_members (
  email        text primary key,
  role         text not null default 'user' check (role in ('admin', 'user')),
  display_name text,
  created_at   timestamptz not null default now(),
  constraint app_members_email_normalized check (email = lower(btrim(email)) and position('@' in email) > 1)
);
comment on table public.app_members is 'Emails allowed to use the app. Accounts are created in Supabase Auth; access is granted here.';

-- Role of the calling user, or NULL when the caller is not an active, confirmed member.
-- SECURITY DEFINER because it must read auth.users (not exposed to the API roles).
create or replace function public.current_member_role()
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

create or replace function public.is_member()
returns boolean
language sql
stable
set search_path = ''
as $$ select public.current_member_role() is not null $$;

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce(public.current_member_role() = 'admin', false) $$;

-- Normalize emails and protect the last admin.
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
    if not exists (select 1 from public.app_members where role = 'admin' and email <> old.email) then
      raise exception 'לא ניתן להסיר את המנהל האחרון' using errcode = '22023';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create trigger app_members_guard
before insert or update or delete on public.app_members
for each row execute function public.app_members_guard();

-- Stamps audit columns from the caller's JWT so they cannot be spoofed by the client.
create or replace function public.stamp_creator()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := auth.uid();
  new.created_by_email := auth.jwt() ->> 'email';
  new.created_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------
-- Open orders ("הזמנות פתוחות") imported from the portal Excel.
-- The newest import is the active one; older imports are pruned.
-- ---------------------------------------------------------------------
create table public.po_imports (
  id               uuid primary key default gen_random_uuid(),
  file_name        text not null,
  file_modified_at timestamptz,
  row_count        integer not null check (row_count >= 0),
  po_count         integer not null check (po_count >= 0),
  created_by       uuid references auth.users (id) on delete set null,
  created_by_email text,
  created_at       timestamptz not null default now()
);
create index po_imports_created_at_idx on public.po_imports (created_at desc);

create trigger po_imports_stamp
before insert on public.po_imports
for each row execute function public.stamp_creator();

create table public.po_lines (
  id          bigint generated always as identity primary key,
  import_id   uuid not null references public.po_imports (id) on delete cascade,
  po          text not null,
  line_no     integer not null check (line_no > 0),
  site_code   bigint not null,
  site_name   text not null default '',
  order_date  date,
  po_desc     text not null default '',
  buyer       text not null default '',
  sku         text not null,
  item_desc   text not null default '',
  qty_ordered numeric not null default 0,
  balance     numeric not null check (balance > 0),
  price       numeric not null default 0,
  line_total  numeric not null default 0,
  unique (import_id, po, line_no)
);

-- Atomically stores a parsed open-orders file and prunes old imports.
create or replace function public.import_open_orders(
  p_file_name text,
  p_file_modified_at timestamptz,
  p_lines jsonb
)
returns uuid
language plpgsql
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

-- ---------------------------------------------------------------------
-- Per-user work in progress (selections before export).
-- items: {"<line_no>": {"q": <qty>, "s": "<sku>"}}
-- ---------------------------------------------------------------------
create table public.drafts (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('delivery', 'invoice_manual')),
  po         text not null,
  doc_number text not null default '',
  doc_date   date,
  items      jsonb not null default '{}'::jsonb check (jsonb_typeof(items) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, po)
);

-- ---------------------------------------------------------------------
-- Export history (immutable). One batch per downloaded CSV/ZIP.
-- ---------------------------------------------------------------------
create table public.export_batches (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('delivery', 'invoice_manual', 'invoice_match')),
  file_name        text not null,
  csv_content      text not null,
  line_count       integer not null check (line_count >= 0),
  total_value      numeric not null default 0,
  pdf_names        text[] not null default '{}',
  meta             jsonb not null default '{}'::jsonb,
  created_by       uuid references auth.users (id) on delete set null,
  created_by_email text,
  created_at       timestamptz not null default now()
);
create index export_batches_created_at_idx on public.export_batches (created_at desc);
create index export_batches_kind_idx on public.export_batches (kind, created_at desc);

create trigger export_batches_stamp
before insert on public.export_batches
for each row execute function public.stamp_creator();

-- Lines of delivery-note exports (kind delivery / invoice_manual).
-- For kind=delivery this is the authoritative source of order-line numbers
-- used later when reconciling invoices.
create table public.export_doc_lines (
  id         bigint generated always as identity primary key,
  batch_id   uuid not null references public.export_batches (id) on delete cascade,
  doc_number text not null,
  doc_date   date,
  site_code  bigint,
  po         text not null,
  line_no    integer,
  sku        text not null,
  item_desc  text,
  qty        numeric not null,
  price      numeric not null
);
create index export_doc_lines_batch_idx on public.export_doc_lines (batch_id);
create index export_doc_lines_doc_idx on public.export_doc_lines (doc_number);

-- Rows written to invoice-reconciliation CSV exports (kind invoice_match).
create table public.export_invoice_lines (
  id        bigint generated always as identity primary key,
  batch_id  uuid not null references public.export_batches (id) on delete cascade,
  inv_no    text not null,
  alloc     text,
  site_code text,
  inv_date  text,
  sku       text not null,
  qty       numeric not null,
  price     numeric not null,
  dn        text not null,
  po        text,
  line_no   text
);
create index export_invoice_lines_batch_idx on public.export_invoice_lines (batch_id);
create index export_invoice_lines_inv_idx on public.export_invoice_lines (inv_no);

-- Atomically records an export with its lines.
create or replace function public.record_export(
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
set search_path = ''
as $$
declare
  v_id    uuid;
  v_count integer;
begin
  if not public.is_member() then
    raise exception 'אין הרשאה' using errcode = '42501';
  end if;

  v_count := coalesce(jsonb_array_length(case when jsonb_typeof(p_doc_lines) = 'array' then p_doc_lines end), 0)
           + coalesce(jsonb_array_length(case when jsonb_typeof(p_invoice_lines) = 'array' then p_invoice_lines end), 0);
  if v_count = 0 then
    raise exception 'אין שורות לייצוא' using errcode = '22023';
  end if;

  insert into public.export_batches (kind, file_name, csv_content, line_count, total_value, pdf_names, meta)
  values (p_kind, p_file_name, p_csv, v_count, coalesce(p_total, 0), coalesce(p_pdf_names, '{}'), coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;

  if jsonb_typeof(p_doc_lines) = 'array' then
    insert into public.export_doc_lines (batch_id, doc_number, doc_date, site_code, po, line_no, sku, item_desc, qty, price)
    select v_id, r.doc_number, r.doc_date, r.site_code, r.po, r.line_no, r.sku, r.item_desc, r.qty, r.price
    from jsonb_to_recordset(p_doc_lines) as r (
      doc_number text, doc_date date, site_code bigint, po text, line_no integer,
      sku text, item_desc text, qty numeric, price numeric
    );
  end if;

  if jsonb_typeof(p_invoice_lines) = 'array' then
    insert into public.export_invoice_lines (batch_id, inv_no, alloc, site_code, inv_date, sku, qty, price, dn, po, line_no)
    select v_id, r.inv_no, r.alloc, r.site_code, r.inv_date, r.sku, r.qty, r.price, r.dn, r.po, r.line_no
    from jsonb_to_recordset(p_invoice_lines) as r (
      inv_no text, alloc text, site_code text, inv_date text, sku text,
      qty numeric, price numeric, dn text, po text, line_no text
    );
  end if;

  return v_id;
end
$$;

-- Previously reported delivery-note lines for the given delivery-note numbers.
create or replace function public.delivery_history_for_docs(p_docs text[])
returns table (
  doc_number text, po text, line_no integer, sku text, qty numeric, price numeric,
  batch_id uuid, created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select l.doc_number, l.po, l.line_no, l.sku, l.qty, l.price, b.id, b.created_at
  from public.export_doc_lines l
  join public.export_batches b on b.id = l.batch_id
  where b.kind = 'delivery'
    and l.doc_number = any (p_docs)
  order by b.created_at, l.id
$$;

-- Invoices already included in previous reconciliation exports.
create or replace function public.invoice_history_for(p_invs text[])
returns table (inv_no text, batch_id uuid, created_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select distinct l.inv_no, b.id, b.created_at
  from public.export_invoice_lines l
  join public.export_batches b on b.id = l.batch_id
  where l.inv_no = any (p_invs)
  order by b.created_at
$$;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.app_members          enable row level security;
alter table public.po_imports           enable row level security;
alter table public.po_lines             enable row level security;
alter table public.drafts               enable row level security;
alter table public.export_batches       enable row level security;
alter table public.export_doc_lines     enable row level security;
alter table public.export_invoice_lines enable row level security;

-- app_members: members can see the list; only admins can change it.
create policy app_members_select on public.app_members
  for select to authenticated using ((select public.is_member()));
create policy app_members_insert on public.app_members
  for insert to authenticated with check ((select public.is_admin()));
create policy app_members_update on public.app_members
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy app_members_delete on public.app_members
  for delete to authenticated using ((select public.is_admin()));

-- open orders: shared among members.
create policy po_imports_select on public.po_imports
  for select to authenticated using ((select public.is_member()));
create policy po_imports_insert on public.po_imports
  for insert to authenticated with check ((select public.is_member()));
create policy po_imports_delete on public.po_imports
  for delete to authenticated using ((select public.is_member()));

create policy po_lines_select on public.po_lines
  for select to authenticated using ((select public.is_member()));
create policy po_lines_insert on public.po_lines
  for insert to authenticated with check ((select public.is_member()));

-- drafts: private to their owner.
create policy drafts_all on public.drafts
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_member()))
  with check (user_id = (select auth.uid()) and (select public.is_member()));

-- export history: members read and append; only admins delete; nobody updates.
create policy export_batches_select on public.export_batches
  for select to authenticated using ((select public.is_member()));
create policy export_batches_insert on public.export_batches
  for insert to authenticated with check ((select public.is_member()));
create policy export_batches_delete on public.export_batches
  for delete to authenticated using ((select public.is_admin()));

create policy export_doc_lines_select on public.export_doc_lines
  for select to authenticated using ((select public.is_member()));
create policy export_doc_lines_insert on public.export_doc_lines
  for insert to authenticated with check ((select public.is_member()));

create policy export_invoice_lines_select on public.export_invoice_lines
  for select to authenticated using ((select public.is_member()));
create policy export_invoice_lines_insert on public.export_invoice_lines
  for insert to authenticated with check ((select public.is_member()));

-- ---------------------------------------------------------------------
-- Privileges: nothing for anon; only what the policies need for authenticated.
-- ---------------------------------------------------------------------
revoke all on public.app_members, public.po_imports, public.po_lines, public.drafts,
              public.export_batches, public.export_doc_lines, public.export_invoice_lines
  from anon, public;

grant select, insert, update, delete on public.app_members to authenticated;
grant select, insert, delete on public.po_imports to authenticated;
grant select, insert on public.po_lines to authenticated;
grant select, insert, update, delete on public.drafts to authenticated;
grant select, insert, delete on public.export_batches to authenticated;
grant select, insert on public.export_doc_lines to authenticated;
grant select, insert on public.export_invoice_lines to authenticated;

revoke execute on function
  public.current_member_role(), public.is_member(), public.is_admin(),
  public.app_members_guard(), public.stamp_creator(),
  public.import_open_orders(text, timestamptz, jsonb),
  public.record_export(text, text, text, numeric, text[], jsonb, jsonb, jsonb),
  public.delivery_history_for_docs(text[]),
  public.invoice_history_for(text[])
  from public, anon;

grant execute on function
  public.current_member_role(), public.is_member(), public.is_admin(),
  public.import_open_orders(text, timestamptz, jsonb),
  public.record_export(text, text, text, numeric, text[], jsonb, jsonb, jsonb),
  public.delivery_history_for_docs(text[]),
  public.invoice_history_for(text[])
  to authenticated;
