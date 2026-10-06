import { describe, expect, it } from 'vitest';
import type { AnalyticsBatch, AnalyticsUser } from '../data/types';
import { bucketize, daysSince, importFreshness, isActiveSince, lastAction, periodStart, relativeAge, totals, totalsByUser } from './analytics';

const now = new Date(2026, 9, 6, 15, 0); // Tue 6 Oct 2026, 15:00 local
const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).toISOString();
const batch = (kind: AnalyticsBatch['kind'], created_at: string, email = 'a@x.co', lines = 2, value = 100): AnalyticsBatch => ({
  kind,
  created_at,
  email,
  lines,
  value,
});
const user = (p: Partial<AnalyticsUser> = {}): AnalyticsUser => ({
  email: 'a@x.co',
  display_name: null,
  role: 'user',
  registered: true,
  last_sign_in_at: null,
  last_export_at: null,
  last_import_at: null,
  last_draft_at: null,
  open_drafts: 0,
  ...p,
});

describe('periods', () => {
  it('a 7-day period is today and the 6 days before, from local midnight', () => {
    const s = periodStart(7, now);
    expect([s.getFullYear(), s.getMonth() + 1, s.getDate(), s.getHours()]).toEqual([2026, 9, 30, 0]);
  });
  it('days since and relative age', () => {
    expect(daysSince(at(2026, 10, 6, 1), now)).toBe(0);
    expect(daysSince(at(2026, 10, 1, 15), now)).toBe(5);
    expect(relativeAge(new Date(now.getTime() - 30 * 1000).toISOString(), now)).toBe('עכשיו');
    expect(relativeAge(new Date(now.getTime() - 5 * 60000).toISOString(), now)).toBe('לפני 5 דקות');
    expect(relativeAge(new Date(now.getTime() - 2 * 3600000).toISOString(), now)).toBe('לפני שעתיים');
    expect(relativeAge(at(2026, 10, 5, 12), now)).toBe('אתמול');
    expect(relativeAge(at(2026, 9, 26, 15), now)).toBe('לפני 10 ימים');
    expect(relativeAge(null, now)).toBe('–');
  });
});

describe('users', () => {
  it('last action is the most recent of export / upload / draft work; sign-in does not count', () => {
    const u = user({
      last_sign_in_at: at(2026, 10, 6, 14),
      last_export_at: at(2026, 10, 2),
      last_draft_at: at(2026, 10, 5),
      last_import_at: at(2026, 10, 1),
    });
    expect(lastAction(u)).toEqual({ at: at(2026, 10, 5), kind: 'draft' });
    expect(lastAction(user({ last_sign_in_at: at(2026, 10, 6) }))).toBeNull();
  });
  it('active means signed in or did anything in the period', () => {
    expect(isActiveSince(user({ last_sign_in_at: at(2026, 10, 5) }), periodStart(7, now))).toBe(true);
    expect(isActiveSince(user({ last_export_at: at(2026, 9, 1) }), periodStart(7, now))).toBe(false);
    expect(isActiveSince(user(), periodStart(7, now))).toBe(false);
  });
});

describe('volume', () => {
  const rows = [
    batch('delivery', at(2026, 10, 6), 'A@x.co', 3, 300),
    batch('invoice_match', at(2026, 10, 6), 'b@x.co', 5, 50.5),
    batch('delivery', at(2026, 10, 1), 'a@x.co', 1, 10),
    batch('delivery', at(2026, 8, 1), 'a@x.co', 9, 999), // outside 30 days
  ];
  it('totals by kind and by user (case-insensitive email)', () => {
    const t = totals(rows.slice(0, 3));
    expect(t).toEqual({
      reports: 3,
      byKind: { delivery: 2, invoice_manual: 0, invoice_match: 1 },
      lines: 9,
      value: 360.5,
    });
    const u = totalsByUser(rows.slice(0, 3));
    expect(u.get('a@x.co')?.reports).toBe(2);
    expect(u.get('b@x.co')?.value).toBe(50.5);
  });
  it('daily buckets for 7 days include empty days and ignore older rows', () => {
    const { granularity, buckets } = bucketize(rows, 7, now);
    expect(granularity).toBe('day');
    expect(buckets.map((b) => b.label)).toEqual(['30/09', '01/10', '02/10', '03/10', '04/10', '05/10', '06/10']);
    expect(buckets.map((b) => b.total)).toEqual([0, 1, 0, 0, 0, 0, 2]);
    expect(buckets[6].counts).toEqual({
      delivery: 1,
      invoice_manual: 0,
      invoice_match: 1,
    });
  });
  it('weekly buckets start on Sunday; monthly buckets cover a year', () => {
    const w = bucketize(rows, 90, now);
    expect(w.granularity).toBe('week');
    expect(w.buckets.at(-1)!.label).toBe('04/10'); // Sunday 4 Oct
    expect(w.buckets.at(-1)!.total).toBe(2);
    expect(w.buckets.reduce((s, b) => s + b.total, 0)).toBe(4);
    const m = bucketize(rows, 365, now);
    expect(m.granularity).toBe('month');
    expect(m.buckets.length).toBe(13); // Oct 2025 … Oct 2026
    expect(m.buckets.at(-1)!.total).toBe(3);
  });
  it('open-orders file freshness', () => {
    expect(importFreshness(at(2026, 10, 5), now)).toBe('ok');
    expect(importFreshness(at(2026, 10, 2), now)).toBe('warn');
    expect(importFreshness(at(2026, 9, 20), now)).toBe('stale');
    expect(importFreshness(null, now)).toBe('stale');
  });
});
