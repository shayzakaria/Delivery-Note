import { describe, expect, it } from 'vitest';
import { isEmptyDraft, reconcileDrafts, type DraftState } from './drafts';
import { groupByPo, type PoLine } from './openOrders';

const line = (po: string, line_no: number, sku: string): PoLine => ({
  po, line_no, sku, site_code: 1, site_name: '', order_date: null, po_desc: '', buyer: '', item_desc: '', qty_ordered: 1, balance: 1, price: 1, line_total: 1,
});

describe('reconcileDrafts', () => {
  const groups = new Map(groupByPo([line('A', 1, 'x'), line('A', 2, 'y'), line('B', 5, 'z')]).map((g) => [g.po, g]));

  it('keeps valid items and drops closed, renumbered or vanished ones', () => {
    const drafts: Record<string, DraftState> = {
      A: { docNumber: '1', docDate: '2026-09-30', items: { '1': { q: '1', s: 'x' }, '2': { q: '1', s: 'CHANGED' }, '3': { q: '1', s: 'w' } } },
      B: { docNumber: '', docDate: '2026-09-30', items: { '5': { q: '1', s: 'z' } } },
      GONE: { docNumber: '9', docDate: '2026-09-30', items: { '1': { q: '1', s: 'q' } } },
    };
    const r = reconcileDrafts(drafts, groups);
    expect(r.dropped).toBe(3);
    expect(r.changed.sort()).toEqual(['A', 'GONE']);
    expect(Object.keys(r.next).sort()).toEqual(['A', 'B']);
    expect(r.next.A.items).toEqual({ '1': { q: '1', s: 'x' } });
    expect(r.next.B).toBe(drafts.B);
  });

  it('reports nothing when all drafts are still valid', () => {
    const r = reconcileDrafts({ B: { docNumber: '', docDate: '', items: { '5': { q: '1', s: 'z' } } } }, groups);
    expect(r).toMatchObject({ dropped: 0, changed: [] });
  });

  it('recognizes empty drafts', () => {
    expect(isEmptyDraft(undefined)).toBe(true);
    expect(isEmptyDraft({ docNumber: ' ', docDate: '2026-01-01', items: {} })).toBe(true);
    expect(isEmptyDraft({ docNumber: '1', docDate: '', items: {} })).toBe(false);
  });
});
