import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../config';
import type { DocKind } from '../lib/docExport';
import type { InvoiceCsvLine } from '../lib/invoiceMatch';
import type { PoLine } from '../lib/openOrders';
import type {
  AuthEvent,
  BatchSummary,
  DataStore,
  DocLineRecord,
  DraftRecord,
  ExportInput,
  HistoryLine,
  ImportInfo,
  Member,
  Role,
  SessionUser,
} from './types';
import { SessionChangedError } from './types';

const PAGE = 1000; // PostgREST returns at most 1000 rows per request

/** Turns Supabase/PostgREST errors into readable Hebrew messages. */
export function friendlyError(err: unknown): Error {
  const msg = (err as { message?: string })?.message || String(err);
  if (/Invalid login credentials/i.test(msg)) return new Error('אימייל או סיסמה שגויים');
  if (/Email not confirmed/i.test(msg)) return new Error('כתובת המייל טרם אומתה');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return new Error('אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.');
  if (/JWT expired|invalid JWT/i.test(msg)) return new Error('פג תוקף ההתחברות. התחבר מחדש.');
  if (/permission denied|row-level security|אין הרשאה/i.test(msg)) return new Error('אין הרשאה לפעולה זו');
  if (/Password should be at least/i.test(msg)) return new Error('הסיסמה קצרה מדי (לפחות 6 תווים)');
  if (/Database error saving new user|EMAIL_NOT_ALLOWED/i.test(msg))
    return new Error('כתובת המייל אינה ברשימת המורשים להרשמה. יש לפנות למנהל המערכת.');
  if (/User already registered/i.test(msg)) return new Error('כבר קיים חשבון עם המייל הזה. אפשר להתחבר או לאפס סיסמה.');
  if (/Signups not allowed/i.test(msg)) return new Error('ההרשמה לאתר סגורה כרגע. יש לפנות למנהל המערכת.');
  if (/rate limit/i.test(msg)) return new Error('יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.');
  if (/duplicate key/i.test(msg)) return new Error('הרשומה כבר קיימת');
  return new Error(msg);
}

function check<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw friendlyError(res.error);
  return res.data;
}

function ensure(res: { error: unknown }): void {
  if (res.error) throw friendlyError(res.error);
}

const toUser = (u: { id: string; email?: string } | null | undefined): SessionUser | null =>
  u ? { id: u.id, email: u.email ?? '' } : null;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export class SupabaseStore implements DataStore {
  readonly mode = 'supabase' as const;
  private sb: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.sb =
      client ??
      createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
  }

  // ---------------- auth ----------------
  async getUser(): Promise<SessionUser | null> {
    const { data } = await this.sb.auth.getSession();
    return toUser(data.session?.user);
  }

  onAuthChange(cb: (event: AuthEvent, user: SessionUser | null) => void): () => void {
    const { data } = this.sb.auth.onAuthStateChange((event, session) => {
      const e: AuthEvent =
        event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'PASSWORD_RECOVERY' ? event : 'OTHER';
      // Defer so auth callbacks never run Supabase calls inside the auth lock.
      setTimeout(() => cb(e, toUser(session?.user)), 0);
    });
    return () => data.subscription.unsubscribe();
  }

  async signIn(email: string, password: string): Promise<void> {
    ensure(await this.sb.auth.signInWithPassword({ email: email.trim(), password }));
  }

  async signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
    const data = check(
      await this.sb.auth.signUp({ email: email.trim().toLowerCase(), password, options: { emailRedirectTo: window.location.origin } }),
    );
    // With email confirmation on, no session is returned until the link in the email is clicked.
    return { needsConfirmation: !data.session };
  }

  async signOut(): Promise<void> {
    ensure(await this.sb.auth.signOut());
  }

  async sendPasswordReset(email: string): Promise<void> {
    ensure(await this.sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin }));
  }

  async updatePassword(password: string): Promise<void> {
    ensure(await this.sb.auth.updateUser({ password }));
  }

  async memberRole(): Promise<Role | null> {
    const role = check(await this.sb.rpc('current_member_role'));
    return role === 'admin' || role === 'user' ? role : null;
  }

  // ---------------- open orders ----------------
  async latestImport(): Promise<ImportInfo | null> {
    const rows = check(
      await this.sb
        .from('po_imports')
        .select('id, file_name, file_modified_at, row_count, po_count, created_by_email, created_at')
        .order('created_at', { ascending: false })
        .limit(1),
    ) as ImportInfo[];
    return rows[0] ?? null;
  }

  async importLines(importId: string): Promise<PoLine[]> {
    const out: PoLine[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = check(
        await this.sb
          .from('po_lines')
          .select('po, line_no, site_code, site_name, order_date, po_desc, buyer, sku, item_desc, qty_ordered, balance, price, line_total')
          .eq('import_id', importId)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1),
      ) as Record<string, unknown>[];
      for (const r of rows) {
        out.push({
          po: String(r.po),
          line_no: num(r.line_no),
          site_code: num(r.site_code),
          site_name: String(r.site_name ?? ''),
          order_date: (r.order_date as string | null) ?? null,
          po_desc: String(r.po_desc ?? ''),
          buyer: String(r.buyer ?? ''),
          sku: String(r.sku ?? ''),
          item_desc: String(r.item_desc ?? ''),
          qty_ordered: num(r.qty_ordered),
          balance: num(r.balance),
          price: num(r.price),
          line_total: num(r.line_total),
        });
      }
      if (rows.length < PAGE) break;
    }
    return out;
  }

  async importOpenOrders(fileName: string, fileModifiedAt: string | null, lines: PoLine[]): Promise<string> {
    const id = check(
      await this.sb.rpc('import_open_orders', {
        p_file_name: fileName,
        p_file_modified_at: fileModifiedAt,
        p_lines: lines,
      }),
    );
    return String(id);
  }

  // ---------------- drafts ----------------
  async loadDrafts(kind: DocKind): Promise<DraftRecord[]> {
    const rows = check(
      await this.sb.from('drafts').select('kind, po, doc_number, doc_date, items').eq('kind', kind).limit(5000),
    ) as DraftRecord[];
    return rows.map((r) => ({ ...r, items: r.items ?? {} }));
  }

  private async requireUser(userId: string): Promise<void> {
    const user = await this.getUser();
    if (!user || user.id !== userId) throw new SessionChangedError();
  }

  async saveDraft(d: DraftRecord, userId: string): Promise<void> {
    await this.requireUser(userId);
    check(
      await this.sb.from('drafts').upsert(
        {
          user_id: userId,
          kind: d.kind,
          po: d.po,
          doc_number: d.doc_number,
          doc_date: d.doc_date || null,
          items: d.items,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,kind,po' },
      ),
    );
  }

  async deleteDrafts(kind: DocKind, pos: string[], userId: string): Promise<void> {
    await this.requireUser(userId);
    for (const part of chunk(pos, 100)) {
      check(await this.sb.from('drafts').delete().eq('user_id', userId).eq('kind', kind).in('po', part));
    }
  }

  // ---------------- export history ----------------
  async recordExport(input: ExportInput): Promise<string> {
    const id = check(
      await this.sb.rpc('record_export', {
        p_kind: input.kind,
        p_file_name: input.file_name,
        p_csv: input.csv,
        p_total: input.total,
        p_pdf_names: input.pdf_names,
        p_meta: input.meta,
        p_doc_lines: input.doc_lines ?? null,
        p_invoice_lines: input.invoice_lines ?? null,
      }),
    );
    return String(id);
  }

  async listBatches(limit: number): Promise<BatchSummary[]> {
    const rows = check(
      await this.sb
        .from('export_batches')
        .select('id, kind, file_name, line_count, total_value, pdf_names, meta, created_by_email, created_at')
        .order('created_at', { ascending: false })
        .limit(limit),
    ) as BatchSummary[];
    return rows.map((r) => ({ ...r, total_value: num(r.total_value), pdf_names: r.pdf_names ?? [], meta: r.meta ?? {} }));
  }

  async batchDocLines(batchId: string): Promise<DocLineRecord[]> {
    const rows = check(
      await this.sb
        .from('export_doc_lines')
        .select('doc_number, doc_date, site_code, po, line_no, sku, item_desc, qty, price')
        .eq('batch_id', batchId)
        .order('id', { ascending: true })
        .limit(PAGE * 5),
    ) as DocLineRecord[];
    return rows.map((r) => ({ ...r, qty: num(r.qty), price: num(r.price), site_code: num(r.site_code), line_no: num(r.line_no) }));
  }

  async batchInvoiceLines(batchId: string): Promise<InvoiceCsvLine[]> {
    const rows = check(
      await this.sb
        .from('export_invoice_lines')
        .select('inv_no, alloc, site_code, inv_date, sku, qty, price, dn, po, line_no')
        .eq('batch_id', batchId)
        .order('id', { ascending: true })
        .limit(PAGE * 5),
    ) as InvoiceCsvLine[];
    return rows.map((r) => ({ ...r, qty: num(r.qty), price: num(r.price), alloc: r.alloc ?? '', po: r.po ?? '', line_no: r.line_no ?? '' }));
  }

  async batchCsv(batchId: string): Promise<string> {
    const row = check(await this.sb.from('export_batches').select('csv_content').eq('id', batchId).single()) as {
      csv_content: string;
    };
    return row.csv_content;
  }

  async deleteBatch(batchId: string): Promise<void> {
    const rows = check(await this.sb.from('export_batches').delete().eq('id', batchId).select('id')) as { id: string }[];
    if (!rows.length) throw new Error('אין הרשאה למחוק (מנהלים בלבד)');
  }

  async deliveryHistoryForDocs(docs: string[]): Promise<HistoryLine[]> {
    const out: HistoryLine[] = [];
    for (const part of chunk([...new Set(docs.filter(Boolean))], 200)) {
      for (let from = 0; ; from += PAGE) {
        const rows = check(
          await this.sb.rpc('delivery_history_with_reporter', { p_docs: part }).range(from, from + PAGE - 1),
        ) as Record<string, unknown>[];
        for (const r of rows) {
          out.push({
            doc_number: String(r.doc_number),
            po: String(r.po ?? ''),
            line_no: r.line_no === null || r.line_no === undefined ? null : num(r.line_no),
            sku: String(r.sku ?? ''),
            qty: num(r.qty),
            price: num(r.price),
            batch_id: String(r.batch_id),
            created_at: String(r.created_at),
            created_by_email: typeof r.created_by_email === 'string' ? r.created_by_email : null,
          });
        }
        if (rows.length < PAGE) break;
      }
    }
    return out;
  }

  async invoiceHistoryFor(invs: string[]): Promise<{ inv_no: string; created_at: string }[]> {
    const out: { inv_no: string; created_at: string }[] = [];
    for (const part of chunk([...new Set(invs.filter(Boolean))], 200)) {
      const rows = check(await this.sb.rpc('invoice_history_for', { p_invs: part }).range(0, PAGE - 1)) as {
        inv_no: string;
        created_at: string;
      }[];
      out.push(...rows);
    }
    return out;
  }

  // ---------------- members ----------------
  async listMembers(): Promise<Member[]> {
    return check(
      await this.sb.from('app_members').select('email, role, display_name, created_at').order('created_at', { ascending: true }),
    ) as Member[];
  }

  async addMember(email: string, role: Role, displayName: string): Promise<void> {
    check(await this.sb.from('app_members').insert({ email: email.trim().toLowerCase(), role, display_name: displayName.trim() || null }));
  }

  async setMemberRole(email: string, role: Role): Promise<void> {
    check(await this.sb.from('app_members').update({ role }).eq('email', email));
  }

  async removeMember(email: string): Promise<void> {
    check(await this.sb.from('app_members').delete().eq('email', email));
  }

  // ---------------- admin-only server functions ----------------
  async adminRpc(name: string): Promise<unknown> {
    return check(await this.sb.rpc(name));
  }
}
