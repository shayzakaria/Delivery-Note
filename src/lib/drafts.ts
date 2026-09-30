import type { PoGroup } from './openOrders';

export interface DraftItemState {
  /** Quantity as typed. */
  q: string;
  /** SKU of the line when it was selected. */
  s: string;
}

export interface DraftState {
  docNumber: string;
  /** YYYY-MM-DD */
  docDate: string;
  /** line_no → item */
  items: Record<string, DraftItemState>;
}

export function isEmptyDraft(d: DraftState | undefined): boolean {
  return !d || (!d.docNumber.trim() && Object.keys(d.items).length === 0);
}

/**
 * Keeps only draft items whose line is still open in the current import with the
 * same SKU. Orders that disappeared lose their items (the document number is kept
 * only if the order still exists).
 */
export function reconcileDrafts(
  drafts: Record<string, DraftState>,
  groups: Map<string, PoGroup>,
): { next: Record<string, DraftState>; dropped: number; changed: string[] } {
  const next: Record<string, DraftState> = {};
  const changed: string[] = [];
  let dropped = 0;
  for (const [po, d] of Object.entries(drafts)) {
    const g = groups.get(po);
    if (!g) {
      const n = Object.keys(d.items).length;
      if (n || d.docNumber) {
        dropped += n;
        changed.push(po);
      }
      continue;
    }
    const byLine = new Map(g.lines.map((l) => [String(l.line_no), l]));
    const items: Record<string, DraftItemState> = {};
    let removed = 0;
    for (const [lineNo, it] of Object.entries(d.items)) {
      const line = byLine.get(lineNo);
      if (line && line.sku === it.s) items[lineNo] = it;
      else removed++;
    }
    dropped += removed;
    if (removed) changed.push(po);
    next[po] = removed ? { ...d, items } : d;
  }
  return { next, dropped, changed };
}
