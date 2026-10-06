// In-browser stand-in for Supabase, used by `npm run dev:mock` and the E2E tests.
// Mirrors the server rules that matter to the UI: newest import wins, 20 imports
// kept, drafts per user, append-only history, members allowlist.
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

// Test hook: `localStorage['mody_mock_fail_loads'] = N` makes the next N open-order
// loads fail (use a large N and reset it to 0 to fail "until further notice"), to
// exercise error handling. Exists only in this demo store.

interface Batch extends BatchSummary {
  csv: string;
  doc_lines: DocLineRecord[];
  invoice_lines: InvoiceCsvLine[];
}

interface MockDb {
  user: SessionUser | null;
  members: Member[];
  imports: (ImportInfo & { lines: PoLine[] })[];
  drafts: (DraftRecord & { user_id: string })[];
  batches: Batch[];
}

const KEY = 'mody_mock_db_v1';

function uid(): string {
  return crypto.randomUUID();
}

function load(): MockDb {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as MockDb;
  } catch {
    /* ignore */
  }
  return {
    user: null,
    members: [{ email: 'demo@mody.co.il', role: 'admin', display_name: 'משתמש הדגמה', created_at: new Date().toISOString() }],
    imports: [],
    drafts: [],
    batches: [],
  };
}

export class MockStore implements DataStore {
  readonly mode = 'mock' as const;
  private db: MockDb = load();
  private listeners = new Set<(event: AuthEvent, user: SessionUser | null) => void>();

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.db));
    } catch {
      /* storage full or unavailable — demo keeps working in memory */
    }
  }

  private emit(event: AuthEvent) {
    for (const l of this.listeners) setTimeout(() => l(event, this.db.user), 0);
  }

  private requireMember(): SessionUser {
    const u = this.db.user;
    if (!u || !this.db.members.some((m) => m.email === u.email.toLowerCase())) throw new Error('אין הרשאה לפעולה זו');
    return u;
  }

  private requireAdmin(): SessionUser {
    const u = this.requireMember();
    if (this.db.members.find((m) => m.email === u.email.toLowerCase())?.role !== 'admin') throw new Error('אין הרשאה לפעולה זו');
    return u;
  }

  async getUser() {
    return this.db.user;
  }

  onAuthChange(cb: (event: AuthEvent, user: SessionUser | null) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async signIn(email: string, password: string) {
    if (password.length < 4) throw new Error('אימייל או סיסמה שגויים');
    this.db.user = { id: 'mock-' + email.trim().toLowerCase(), email: email.trim().toLowerCase() };
    this.save();
    this.emit('SIGNED_IN');
  }

  async signUp(email: string, password: string) {
    const clean = email.trim().toLowerCase();
    if (!this.db.members.some((m) => m.email === clean)) throw new Error('כתובת המייל אינה ברשימת המורשים להרשמה. יש לפנות למנהל המערכת.');
    if (password.length < 8) throw new Error('יש לבחור סיסמה של 8 תווים לפחות');
    await this.signIn(clean, password);
    return { needsConfirmation: false };
  }

  async signOut() {
    this.db.user = null;
    this.save();
    this.emit('SIGNED_OUT');
  }

  async sendPasswordReset() {}

  async updatePassword(password: string) {
    if (password.length < 6) throw new Error('הסיסמה קצרה מדי (לפחות 6 תווים)');
  }

  async memberRole(): Promise<Role | null> {
    const u = this.db.user;
    return (u && this.db.members.find((m) => m.email === u.email.toLowerCase())?.role) || null;
  }

  async latestImport(): Promise<ImportInfo | null> {
    this.requireMember();
    const failures = Number(localStorage.getItem('mody_mock_fail_loads') || 0);
    if (failures > 0) {
      localStorage.setItem('mody_mock_fail_loads', String(failures - 1));
      throw new Error('אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.');
    }
    const i = this.db.imports[0];
    if (!i) return null;
    const { lines: _lines, ...info } = i;
    return info;
  }

  async importLines(importId: string) {
    this.requireMember();
    return this.db.imports.find((i) => i.id === importId)?.lines ?? [];
  }

  async importOpenOrders(fileName: string, fileModifiedAt: string | null, lines: PoLine[]) {
    const u = this.requireMember();
    if (!lines.length) throw new Error('הקובץ אינו מכיל שורות');
    const id = uid();
    this.db.imports.unshift({
      id,
      file_name: fileName,
      file_modified_at: fileModifiedAt,
      row_count: lines.length,
      po_count: new Set(lines.map((l) => l.po)).size,
      created_by_email: u.email,
      created_at: new Date().toISOString(),
      lines,
    });
    this.db.imports = this.db.imports.slice(0, 20);
    this.save();
    return id;
  }

  async loadDrafts(kind: DocKind) {
    const u = this.requireMember();
    return this.db.drafts.filter((d) => d.user_id === u.id && d.kind === kind).map(({ user_id: _u, ...d }) => d);
  }

  async saveDraft(d: DraftRecord, userId: string) {
    const u = this.requireMember();
    if (u.id !== userId) throw new SessionChangedError();
    this.db.drafts = this.db.drafts.filter((x) => !(x.user_id === u.id && x.kind === d.kind && x.po === d.po));
    this.db.drafts.push({ ...d, user_id: u.id });
    this.save();
  }

  async deleteDrafts(kind: DocKind, pos: string[], userId: string) {
    const u = this.requireMember();
    if (u.id !== userId) throw new SessionChangedError();
    const set = new Set(pos);
    this.db.drafts = this.db.drafts.filter((x) => !(x.user_id === u.id && x.kind === kind && set.has(x.po)));
    this.save();
  }

  async recordExport(input: ExportInput) {
    const u = this.requireMember();
    const count = (input.doc_lines?.length ?? 0) + (input.invoice_lines?.length ?? 0);
    if (!count) throw new Error('אין שורות לייצוא');
    const id = uid();
    this.db.batches.unshift({
      id,
      kind: input.kind,
      file_name: input.file_name,
      line_count: count,
      total_value: input.total,
      pdf_names: input.pdf_names,
      meta: input.meta,
      created_by_email: u.email,
      created_at: new Date().toISOString(),
      csv: input.csv,
      doc_lines: input.doc_lines ?? [],
      invoice_lines: input.invoice_lines ?? [],
    });
    this.save();
    return id;
  }

  async listBatches(limit: number): Promise<BatchSummary[]> {
    this.requireMember();
    return this.db.batches.slice(0, limit).map(({ csv: _c, doc_lines: _d, invoice_lines: _i, ...b }) => b);
  }

  async batchDocLines(id: string) {
    this.requireMember();
    return this.db.batches.find((b) => b.id === id)?.doc_lines ?? [];
  }

  async batchInvoiceLines(id: string) {
    this.requireMember();
    return this.db.batches.find((b) => b.id === id)?.invoice_lines ?? [];
  }

  async batchCsv(id: string) {
    this.requireMember();
    return this.db.batches.find((b) => b.id === id)?.csv ?? '';
  }

  async deleteBatch(id: string) {
    this.requireAdmin();
    this.db.batches = this.db.batches.filter((b) => b.id !== id);
    this.save();
  }

  async deliveryHistoryForDocs(docs: string[]): Promise<HistoryLine[]> {
    this.requireMember();
    const set = new Set(docs);
    const out: HistoryLine[] = [];
    for (const b of [...this.db.batches].reverse()) {
      if (b.kind !== 'delivery') continue;
      for (const l of b.doc_lines) {
        if (set.has(l.doc_number))
          out.push({ doc_number: l.doc_number, po: l.po, line_no: l.line_no, sku: l.sku, qty: l.qty, price: l.price, batch_id: b.id, created_at: b.created_at, created_by_email: b.created_by_email });
      }
    }
    return out;
  }

  async invoiceHistoryFor(invs: string[]) {
    this.requireMember();
    const set = new Set(invs);
    const out: { inv_no: string; created_at: string }[] = [];
    for (const b of [...this.db.batches].reverse()) {
      for (const inv of new Set(b.invoice_lines.map((l) => l.inv_no))) if (set.has(inv)) out.push({ inv_no: inv, created_at: b.created_at });
    }
    return out;
  }

  async listMembers() {
    const u = this.requireMember();
    const admin = this.db.members.find((m) => m.email === u.email.toLowerCase())?.role === 'admin';
    // The demo has no account table: the signed-in user counts as registered, everyone else as not yet.
    return this.db.members.map((m) =>
      admin ? { ...m, account_status: m.email === u.email.toLowerCase() ? ('active' as const) : ('none' as const), last_sign_in_at: null } : { ...m },
    );
  }

  async addMember(email: string, role: Role, displayName: string) {
    this.requireAdmin();
    const e = email.trim().toLowerCase();
    if (!e.includes('@')) throw new Error('כתובת מייל לא תקינה');
    if (this.db.members.some((m) => m.email === e)) throw new Error('הרשומה כבר קיימת');
    this.db.members.push({ email: e, role, display_name: displayName.trim() || null, created_at: new Date().toISOString() });
    this.save();
  }

  async setMemberRole(email: string, role: Role) {
    this.requireAdmin();
    const m = this.db.members.find((x) => x.email === email);
    if (!m) return;
    if (m.role === 'admin' && role !== 'admin' && !this.db.members.some((x) => x.role === 'admin' && x.email !== email)) {
      throw new Error('לא ניתן להסיר את המנהל האחרון');
    }
    m.role = role;
    this.save();
  }

  async removeMember(email: string) {
    this.requireAdmin();
    const m = this.db.members.find((x) => x.email === email);
    if (m?.role === 'admin' && !this.db.members.some((x) => x.role === 'admin' && x.email !== email)) {
      throw new Error('לא ניתן להסיר את המנהל האחרון');
    }
    this.db.members = this.db.members.filter((x) => x.email !== email);
    this.save();
  }
}
