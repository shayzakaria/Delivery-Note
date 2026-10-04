import type { DocKind } from '../lib/docExport';
import type { HistLine, InvoiceCsvLine } from '../lib/invoiceMatch';
import type { PoLine } from '../lib/openOrders';

export type Role = 'admin' | 'user';

export interface SessionUser {
  id: string;
  email: string;
}

export interface ImportInfo {
  id: string;
  file_name: string;
  file_modified_at: string | null;
  row_count: number;
  po_count: number;
  created_by_email: string | null;
  created_at: string;
}

export interface DraftItem {
  /** Quantity as typed. */
  q: string;
  /** SKU of the line when it was selected — guards against line numbers shifting between imports. */
  s: string;
}

export interface DraftRecord {
  kind: DocKind;
  po: string;
  doc_number: string;
  /** YYYY-MM-DD */
  doc_date: string | null;
  /** line_no → item */
  items: Record<string, DraftItem>;
}

export type ExportKind = DocKind | 'invoice_match';

export interface DocLineRecord {
  doc_number: string;
  doc_date: string | null;
  site_code: number;
  po: string;
  line_no: number;
  sku: string;
  item_desc: string;
  qty: number;
  price: number;
}

export interface ExportInput {
  kind: ExportKind;
  file_name: string;
  csv: string;
  total: number;
  pdf_names: string[];
  meta: Record<string, unknown>;
  doc_lines?: DocLineRecord[];
  invoice_lines?: InvoiceCsvLine[];
}

export interface BatchSummary {
  id: string;
  kind: ExportKind;
  file_name: string;
  line_count: number;
  total_value: number;
  pdf_names: string[];
  meta: Record<string, unknown>;
  created_by_email: string | null;
  created_at: string;
}

export interface HistoryLine extends HistLine {
  batch_id: string;
  created_at: string;
}

export interface Member {
  email: string;
  role: Role;
  display_name: string | null;
  created_at: string;
  /** Admin view only: whether this email already has an account. */
  account_status?: AccountStatus;
  last_sign_in_at?: string | null;
}

/** none = not registered yet, unconfirmed = registered but email not verified, active = can sign in. */
export type AccountStatus = 'none' | 'unconfirmed' | 'active';

export type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'PASSWORD_RECOVERY' | 'OTHER';

/** Thrown when a write was prepared for one user but the session now belongs to another (or none). */
export class SessionChangedError extends Error {
  constructor() {
    super('ההתחברות השתנתה — השינוי לא נשמר');
    this.name = 'SessionChangedError';
  }
}

export interface DataStore {
  readonly mode: 'supabase' | 'mock';

  // --- auth ---
  getUser(): Promise<SessionUser | null>;
  onAuthChange(cb: (event: AuthEvent, user: SessionUser | null) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  /** Creates an account; only emails on the members list are accepted (enforced by the database). */
  signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }>;
  signOut(): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  memberRole(): Promise<Role | null>;

  // --- open orders ---
  latestImport(): Promise<ImportInfo | null>;
  importLines(importId: string): Promise<PoLine[]>;
  importOpenOrders(fileName: string, fileModifiedAt: string | null, lines: PoLine[]): Promise<string>;

  // --- drafts ---
  loadDrafts(kind: DocKind): Promise<DraftRecord[]>;
  /** Writes only if `userId` is still the signed-in user (else SessionChangedError). */
  saveDraft(d: DraftRecord, userId: string): Promise<void>;
  deleteDrafts(kind: DocKind, pos: string[], userId: string): Promise<void>;

  // --- export history ---
  recordExport(input: ExportInput): Promise<string>;
  listBatches(limit: number): Promise<BatchSummary[]>;
  batchDocLines(batchId: string): Promise<DocLineRecord[]>;
  batchInvoiceLines(batchId: string): Promise<InvoiceCsvLine[]>;
  batchCsv(batchId: string): Promise<string>;
  deleteBatch(batchId: string): Promise<void>;
  deliveryHistoryForDocs(docs: string[]): Promise<HistoryLine[]>;
  invoiceHistoryFor(invs: string[]): Promise<{ inv_no: string; created_at: string }[]>;

  // --- members ---
  listMembers(): Promise<Member[]>;
  addMember(email: string, role: Role, displayName: string): Promise<void>;
  setMemberRole(email: string, role: Role): Promise<void>;
  removeMember(email: string): Promise<void>;
}
