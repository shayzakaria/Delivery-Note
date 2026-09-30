-- Supabase grants ALL on new public tables to `authenticated` by default.
-- RLS already blocks anything without a policy; this also removes the
-- underlying privileges so the database enforces least privilege twice.
revoke all on public.app_members, public.po_imports, public.po_lines, public.drafts,
              public.export_batches, public.export_doc_lines, public.export_invoice_lines
  from authenticated;

grant select, insert, update, delete on public.app_members to authenticated;
grant select, insert, delete on public.po_imports to authenticated;
grant select, insert on public.po_lines to authenticated;
grant select, insert, update, delete on public.drafts to authenticated;
grant select, insert, delete on public.export_batches to authenticated;
grant select, insert on public.export_doc_lines to authenticated;
grant select, insert on public.export_invoice_lines to authenticated;
