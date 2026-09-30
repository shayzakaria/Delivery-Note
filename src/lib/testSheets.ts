// Test helpers: build real .xlsx bytes from arrays so tests exercise the same
// parsing path as uploaded files. All data here is synthetic.
import * as XLSX from 'xlsx';

export function xlsxBytes(aoa: unknown[][], opts: { dateFormat?: string } = {}): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: opts.dateFormat ?? 'dd/mm/yy' });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/** A row of the portal open-orders export, placing values at the production column indexes. */
export function openOrderRow(v: {
  site: unknown;
  siteName?: string;
  date?: unknown;
  po: unknown;
  desc?: string;
  buyer?: string;
  sku: unknown;
  item?: string;
  ordered?: unknown;
  balance: unknown;
  price: unknown;
  total?: unknown;
}): unknown[] {
  const r: unknown[] = new Array(18).fill(null);
  r[0] = v.site;
  r[1] = v.siteName ?? 'אתר בדיקה';
  r[2] = 'חברת בדיקה';
  r[3] = v.date ?? null;
  r[4] = v.po;
  r[5] = v.desc ?? '';
  r[6] = v.buyer ?? 'קניין';
  r[9] = v.sku;
  r[11] = v.item ?? 'פריט';
  r[12] = v.ordered ?? v.balance;
  r[13] = v.balance;
  r[15] = v.price;
  r[17] = v.total ?? null;
  return r;
}

export const OPEN_ORDERS_HEADER = [
  'אתר', 'שם אתר', 'חברה', 'תאריך', 'הזמנה', 'פרטים', 'קניין', 'סטטוס', 'שורה', 'מקט', 'מקט יצרן', 'תאור', 'כמות בהזמנה', 'כמות למשלוח', 'יחידה', 'מחיר', 'מטבע', 'סהכ',
];
