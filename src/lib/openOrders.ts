import { isPresent, text, toInt, toISODate, toNumber, type SheetData } from './cells';

/** One open line of a purchase order, from the portal's "הזמנות פתוחות" Excel export. */
export interface PoLine {
  po: string;
  /** Position of the line inside its PO in the portal file (1-based, counts closed lines too). */
  line_no: number;
  site_code: number;
  site_name: string;
  /** YYYY-MM-DD or null */
  order_date: string | null;
  po_desc: string;
  buyer: string;
  sku: string;
  item_desc: string;
  qty_ordered: number;
  /** Quantity still to deliver ("כמות למשלוח"). Always > 0. */
  balance: number;
  price: number;
  line_total: number;
}

// Column positions in the portal export (0-based), as used by the production app.
export const OPEN_ORDER_COLUMNS = {
  siteCode: 0,
  siteName: 1,
  date: 3,
  po: 4,
  poDesc: 5,
  buyer: 6,
  sku: 9,
  itemDesc: 11,
  qtyOrdered: 12,
  balance: 13,
  price: 15,
  lineTotal: 17,
} as const;

/**
 * Parses the open-orders export.
 * A row counts when it has a site (A) and an order number (E). Line numbers are
 * assigned per order in file order BEFORE dropping lines with nothing left to
 * deliver, so they stay aligned with the order's real line numbers.
 */
export function parseOpenOrders(sheet: SheetData): PoLine[] {
  const C = OPEN_ORDER_COLUMNS;
  const out: PoLine[] = [];
  const counter = new Map<string, number>();
  for (const r of sheet.rows) {
    if (!r || !isPresent(r[C.siteCode]) || !isPresent(r[C.po])) continue;
    const po = text(r[C.po]);
    const line_no = (counter.get(po) ?? 0) + 1;
    counter.set(po, line_no);
    const balance = toNumber(r[C.balance]);
    if (!(balance > 0)) continue;
    out.push({
      po,
      line_no,
      site_code: toInt(r[C.siteCode]),
      site_name: text(r[C.siteName]),
      order_date: toISODate(r[C.date], sheet.date1904),
      po_desc: text(r[C.poDesc]),
      buyer: text(r[C.buyer]),
      sku: text(r[C.sku]),
      item_desc: text(r[C.itemDesc]),
      qty_ordered: toNumber(r[C.qtyOrdered]),
      balance,
      price: toNumber(r[C.price]),
      line_total: toNumber(r[C.lineTotal]),
    });
  }
  return out;
}

export interface PoGroup {
  po: string;
  site_code: number;
  site_name: string;
  order_date: string | null;
  po_desc: string;
  buyer: string;
  lines: PoLine[];
}

/** Groups lines by order, keeping the file order of both orders and lines. */
export function groupByPo(lines: PoLine[]): PoGroup[] {
  const map = new Map<string, PoGroup>();
  for (const l of lines) {
    let g = map.get(l.po);
    if (!g) {
      g = { po: l.po, site_code: l.site_code, site_name: l.site_name, order_date: l.order_date, po_desc: l.po_desc, buyer: l.buyer, lines: [] };
      map.set(l.po, g);
    }
    g.lines.push(l);
  }
  return [...map.values()];
}

/**
 * Order search, same rules as the production app: text match on the order number
 * or its description, or — for queries with at least 3 digits — a digits-only
 * substring match on the order number ("101" finds PO202600000101).
 */
export function matchesQuery(g: PoGroup, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (g.po.toLowerCase().includes(q)) return true;
  if (g.po_desc.toLowerCase().includes(q)) return true;
  const numQ = q.replace(/[^0-9]/g, '');
  return numQ.length >= 3 && g.po.replace(/[^0-9]/g, '').includes(numQ);
}

/** Distinct values in first-appearance order. */
export function distinct(values: string[]): string[] {
  return [...new Set(values)];
}
