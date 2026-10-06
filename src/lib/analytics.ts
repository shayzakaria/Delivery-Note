// Pure helpers for the admin analytics dashboard. All dates are compared in the
// browser's local time (Israel for the users of this app).
import type { AnalyticsBatch, AnalyticsUser, ExportKind } from '../data/types';
import { pad2 } from './format';

export const PERIODS = [7, 30, 90, 365] as const;
export type Period = (typeof PERIODS)[number];

export const KIND_LABEL: Record<ExportKind, string> = {
  delivery: 'תעודות משלוח',
  invoice_manual: 'חשבוניות',
  invoice_match: 'התאמת חשבוניות',
};
/** Fixed series order for charts and tables. */
export const KINDS: ExportKind[] = ['delivery', 'invoice_match', 'invoice_manual'];

const DAY = 24 * 60 * 60 * 1000;

/** Local midnight `days - 1` days before `now`, so a 7-day period is today plus the 6 days before. */
export function periodStart(days: number, now: Date = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - (days - 1));
  return d;
}

export function inPeriod<T extends { created_at: string }>(rows: T[], since: Date): T[] {
  const t = since.getTime();
  return rows.filter((r) => new Date(r.created_at).getTime() >= t);
}

/** Whole days since a timestamp (0 = within the last 24 hours). */
export function daysSince(ts: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(ts).getTime()) / DAY));
}

/** "לפני 5 דקות" / "לפני 3 שעות" / "אתמול" / "לפני 12 ימים". */
export function relativeAge(ts: string | null, now: Date = new Date()): string {
  if (!ts) return '–';
  const ms = now.getTime() - new Date(ts).getTime();
  if (Number.isNaN(ms)) return '–';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'עכשיו';
  if (min < 60) return min === 1 ? 'לפני דקה' : `לפני ${min} דקות`;
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? 'לפני שעה' : h === 2 ? 'לפני שעתיים' : `לפני ${h} שעות`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'אתמול';
  if (d === 2) return 'לפני יומיים';
  return `לפני ${d} ימים`;
}

export type ActionKind = 'export' | 'import' | 'draft';
export const ACTION_LABEL: Record<ActionKind, string> = {
  export: 'ייצוא דיווח',
  import: 'העלאת קובץ הזמנות',
  draft: 'עבודה על בחירות',
};

/** The most recent thing a user did in the app (sign-in itself is not an action). */
export function lastAction(u: AnalyticsUser): { at: string; kind: ActionKind } | null {
  const c: { at: string | null; kind: ActionKind }[] = [
    { at: u.last_export_at, kind: 'export' },
    { at: u.last_import_at, kind: 'import' },
    { at: u.last_draft_at, kind: 'draft' },
  ];
  let best: { at: string; kind: ActionKind } | null = null;
  for (const x of c) if (x.at && (!best || new Date(x.at) > new Date(best.at))) best = { at: x.at, kind: x.kind };
  return best;
}

/** Signed in or did anything since `since`. */
export function isActiveSince(u: AnalyticsUser, since: Date): boolean {
  const t = since.getTime();
  return [u.last_sign_in_at, u.last_export_at, u.last_import_at, u.last_draft_at].some((x) => !!x && new Date(x).getTime() >= t);
}

export interface UserTotals {
  reports: number;
  byKind: Record<ExportKind, number>;
  lines: number;
  value: number;
}
const emptyTotals = (): UserTotals => ({
  reports: 0,
  byKind: { delivery: 0, invoice_manual: 0, invoice_match: 0 },
  lines: 0,
  value: 0,
});

export function totals(batches: AnalyticsBatch[]): UserTotals {
  const t = emptyTotals();
  for (const b of batches) {
    t.reports++;
    t.byKind[b.kind]++;
    t.lines += b.lines;
    t.value += b.value;
  }
  return t;
}

export function totalsByUser(batches: AnalyticsBatch[]): Map<string, UserTotals> {
  const m = new Map<string, UserTotals>();
  for (const b of batches) {
    const key = (b.email ?? '').toLowerCase();
    const t = m.get(key) ?? emptyTotals();
    t.reports++;
    t.byKind[b.kind]++;
    t.lines += b.lines;
    t.value += b.value;
    m.set(key, t);
  }
  return m;
}

export interface Bucket {
  key: string;
  label: string;
  /** Full description for the tooltip. */
  title: string;
  counts: Record<ExportKind, number>;
  total: number;
}

export type Granularity = 'day' | 'week' | 'month';
export const granularityFor = (days: number): Granularity => (days <= 31 ? 'day' : days <= 120 ? 'week' : 'month');

const ddmm = (d: Date) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
const MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];

/** Start of the bucket that contains `d` (weeks start on Sunday, as in Israel). */
function bucketStart(d: Date, g: Granularity): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (g === 'week') s.setDate(s.getDate() - s.getDay());
  if (g === 'month') s.setDate(1);
  return s;
}
function nextBucket(d: Date, g: Granularity): Date {
  const n = new Date(d);
  if (g === 'day') n.setDate(n.getDate() + 1);
  else if (g === 'week') n.setDate(n.getDate() + 7);
  else n.setMonth(n.getMonth() + 1);
  return n;
}
const keyOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Reports per day / week / month over the period, with empty buckets included. */
export function bucketize(batches: AnalyticsBatch[], days: number, now: Date = new Date()): { granularity: Granularity; buckets: Bucket[] } {
  const g = granularityFor(days);
  const since = periodStart(days, now);
  const buckets: Bucket[] = [];
  const index = new Map<string, Bucket>();
  for (let s = bucketStart(since, g); s <= now; s = nextBucket(s, g)) {
    const end = new Date(nextBucket(s, g).getTime() - DAY);
    const label = g === 'month' ? MONTHS[s.getMonth()] : ddmm(s);
    const title =
      g === 'day' ? `${ddmm(s)}/${s.getFullYear()}` : g === 'week' ? `שבוע ${ddmm(s)}–${ddmm(end)}` : `${MONTHS[s.getMonth()]} ${s.getFullYear()}`;
    const b: Bucket = {
      key: keyOf(s),
      label,
      title,
      counts: { delivery: 0, invoice_manual: 0, invoice_match: 0 },
      total: 0,
    };
    buckets.push(b);
    index.set(b.key, b);
  }
  for (const r of inPeriod(batches, since)) {
    const b = index.get(keyOf(bucketStart(new Date(r.created_at), g)));
    if (!b) continue;
    b.counts[r.kind]++;
    b.total++;
  }
  return { granularity: g, buckets };
}

export type Freshness = 'ok' | 'warn' | 'stale';
/** How current the shared open-orders file is, by days since it was uploaded. */
export function importFreshness(uploadedAt: string | null, now: Date = new Date()): Freshness {
  if (!uploadedAt) return 'stale';
  const d = daysSince(uploadedAt, now);
  return d <= 2 ? 'ok' : d <= 6 ? 'warn' : 'stale';
}
