import { text, toISODate, toNumber, type Cell, type Row, type SheetData } from './cells';
import { cleanNum, isoToDDMMYY } from './format';
import { docNumsMatch, extractDocNum } from './pdfMatch';

// Invoice reconciliation.
// Sources: (a) the portal "סטטוס משלוחים" report — item level, amounts before VAT;
//          (b) our ERP invoice report — invoice level, amounts including VAT.
// Rows are joined on the supplier delivery-note number.

export const norm = (v: Cell | undefined): string => text(v);

const stripQuotes = (s: string) => s.replace(/["'׳״]/g, '');

/** Finds the header row (within the first 25 rows) and maps logical keys to column indexes. */
export function headerIndex(rows: Row[], needles: Record<string, string[]>): { row: number; idx: Record<string, number> } | null {
  const keys = Object.keys(needles);
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const cells = (rows[r] || []).map((c) => norm(c));
    const idx: Record<string, number> = {};
    for (const key of keys) {
      const names = needles[key];
      const i = cells.findIndex((c) => names.some((n) => c === n || stripQuotes(c) === stripQuotes(n)));
      if (i >= 0) idx[key] = i;
    }
    if (Object.keys(idx).length >= Math.ceil(keys.length * 0.6)) return { row: r, idx };
  }
  return null;
}

const cell = (c: Row, i: number | undefined): Cell => (i === undefined ? null : (c[i] ?? null));

export interface PortalLine {
  sku: string;
  desc: string;
  qty: number;
  price: number;
  total: number;
}

export interface PortalDN {
  site: string;
  gr: string;
  status: string;
  rows: PortalLine[];
  total: number;
}

export class SheetFormatError extends Error {}

/** Portal delivery-status report → delivery-note number → lines and net total. */
export function parsePortalDN(sheet: SheetData): Map<string, PortalDN> {
  const rows = sheet.rows;
  const h = headerIndex(rows, {
    site: ['אתר'],
    date: ['תאריך'],
    gr: ['תעודה סולל'],
    dn: ['תעודת ספק'],
    status: ['סטטוס'],
    sku: ['מקט'],
    desc: ['תאור'],
    qty: ['כמות שהתקבלה'],
    price: ['מחיר יחידה'],
    total: ['סהכ מחיר'],
  });
  if (!h || h.idx.dn === undefined) throw new SheetFormatError('לא זוהתה עמודת "תעודת ספק" בקובץ הפורטל.');
  const map = new Map<string, PortalDN>();
  for (let r = h.row + 1; r < rows.length; r++) {
    const c = rows[r] || [];
    const dn = norm(cell(c, h.idx.dn));
    if (!dn) continue;
    let entry = map.get(dn);
    if (!entry) {
      entry = { site: norm(cell(c, h.idx.site)), gr: norm(cell(c, h.idx.gr)), status: norm(cell(c, h.idx.status)), rows: [], total: 0 };
      map.set(dn, entry);
    }
    const line: PortalLine = {
      sku: norm(cell(c, h.idx.sku)),
      desc: norm(cell(c, h.idx.desc)),
      qty: toNumber(cell(c, h.idx.qty)),
      price: toNumber(cell(c, h.idx.price)),
      total: toNumber(cell(c, h.idx.total)),
    };
    entry.rows.push(line);
    entry.total = cleanNum(entry.total + line.total);
  }
  return map;
}

export interface InvoiceRow {
  invNo: string;
  dn: string;
  amount: number;
  /** DD/MM/YY */
  date: string;
  alloc: string;
  po: string;
  siteCode: string;
  custName: string;
}

/** ERP invoice report → one entry per row. */
export function parseInvoiceReport(sheet: SheetData): InvoiceRow[] {
  const rows = sheet.rows;
  const h = headerIndex(rows, {
    invNo: ['מספר חשבונית'],
    amount: ['סכום חשבונית'],
    date: ['תאריך חשבונית'],
    alloc: ['מספר הקצאה'],
    dn: ['תעודת משלוח'],
    po: ['הזמנת שוב', 'הזמנת שו"ב'],
    siteCode: ['מס.פרוייקט שוב', 'מס.פרוייקט שו"ב'],
    custName: ['שם לקוח'],
  });
  if (!h || h.idx.invNo === undefined || h.idx.dn === undefined) {
    throw new SheetFormatError('לא זוהו עמודות "מספר חשבונית" / "תעודת משלוח" בדוח החשבוניות.');
  }
  const list: InvoiceRow[] = [];
  for (let r = h.row + 1; r < rows.length; r++) {
    const c = rows[r] || [];
    const invNo = norm(cell(c, h.idx.invNo));
    if (!invNo) continue;
    list.push({
      invNo,
      dn: norm(cell(c, h.idx.dn)),
      amount: toNumber(cell(c, h.idx.amount)),
      date: toDDMMYY(cell(c, h.idx.date), sheet.date1904),
      alloc: norm(cell(c, h.idx.alloc)),
      po: norm(cell(c, h.idx.po)),
      siteCode: norm(cell(c, h.idx.siteCode)),
      custName: norm(cell(c, h.idx.custName)),
    });
  }
  return list;
}

/** Date cell → DD/MM/YY. Unrecognized text is returned trimmed, as-is. */
export function toDDMMYY(v: Cell, date1904 = false): string {
  const iso = toISODate(v, date1904);
  if (iso) return isoToDDMMYY(iso);
  return text(v);
}

export type MatchStatus = 'ok' | 'diff' | 'missing';

export interface MatchRow extends InvoiceRow {
  /** Stable per-row key (an invoice may appear on more than one row). */
  key: string;
  status: MatchStatus;
  portalNet: number | null;
  portalGross: number | null;
  diff: number | null;
  site: string;
  gr: string;
  lines: PortalLine[];
}

export interface MatchResult {
  rows: MatchRow[];
  siteCodeByName: Record<string, string>;
}

export function runMatch(portal: Map<string, PortalDN>, invoices: InvoiceRow[], vatPct: number, tolerance: number): MatchResult {
  const vat = 1 + (Number.isFinite(vatPct) ? vatPct : 0) / 100;
  const tol = Math.abs(Number.isFinite(tolerance) ? tolerance : 0);
  const siteCodeByName: Record<string, string> = {};
  for (const iv of invoices) {
    const p = portal.get(iv.dn);
    if (p && p.site && iv.siteCode) siteCodeByName[p.site] = iv.siteCode;
  }
  const seen = new Map<string, number>();
  const rows = invoices.map((iv): MatchRow => {
    const base = `${iv.invNo}|${iv.dn}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const key = n === 1 ? base : `${base}#${n}`;
    const p = portal.get(iv.dn);
    if (!p) return { ...iv, key, status: 'missing', portalNet: null, portalGross: null, diff: null, site: '', gr: '', lines: [] };
    const net = p.total;
    const gross = net * vat;
    const diff = iv.amount - gross;
    return {
      ...iv,
      key,
      status: Math.abs(diff) <= tol ? 'ok' : 'diff',
      portalNet: net,
      portalGross: gross,
      diff,
      site: p.site,
      gr: p.gr,
      siteCode: iv.siteCode || siteCodeByName[p.site] || '',
      lines: p.rows,
    };
  });
  return { rows, siteCodeByName };
}

/** The portal rejects zero-price lines, so any line under ₪1 is left out of the file. */
export const MIN_LINE_PRICE = 1;

export const exportableLines = (r: MatchRow): PortalLine[] => r.lines.filter((l) => l.price >= MIN_LINE_PRICE);

/**
 * Exportable lines whose received quantity is 0 although the portal still prices
 * them (total > 0). The file reports the received quantity, so such a line goes out
 * as "0 × price" — worth a manual look before uploading.
 */
export const zeroQtyLines = (r: MatchRow): PortalLine[] => exportableLines(r).filter((l) => l.qty === 0 && l.total > 0);

/**
 * Invoice amount implied by the lines that actually go into the file (Σ qty × price, plus VAT).
 * Differs from the portal total when lines are dropped (< ₪1) or report a received quantity
 * that does not match the priced quantity.
 */
export function exportedGross(r: MatchRow, vatPct: number): number {
  const vat = 1 + (Number.isFinite(vatPct) ? vatPct : 0) / 100;
  return cleanNum(exportableLines(r).reduce((s, l) => s + l.qty * l.price, 0) * vat);
}

/** True when the file's lines add up to the invoice amount within the tolerance. */
export function linesMatchInvoice(r: MatchRow, vatPct: number, tolerance: number): boolean {
  return Math.abs(exportedGross(r, vatPct) - r.amount) <= Math.abs(Number.isFinite(tolerance) ? tolerance : 0);
}

/**
 * An order-line number is needed only when the same SKU appears in the same
 * delivery note at different prices — only then can't the portal tell the lines apart.
 */
export function lineNoRequired(r: MatchRow): Set<string> {
  const bySku = new Map<string, Set<number>>();
  for (const l of exportableLines(r)) {
    if (!bySku.has(l.sku)) bySku.set(l.sku, new Set());
    bySku.get(l.sku)!.add(l.price);
  }
  const need = new Set<string>();
  for (const [sku, prices] of bySku) if (prices.size > 1) need.add(sku);
  return need;
}

/** A line previously reported in the delivery tab. */
export interface HistLine {
  doc_number: string;
  po: string;
  line_no: number | null;
  sku: string;
  qty: number;
  price: number;
}

export interface HistEntry {
  po: string;
  lines: HistLine[];
}

/** delivery-note number → previously reported lines (from the export history). */
export function buildHistoryIndex(lines: HistLine[]): Map<string, HistEntry> {
  const idx = new Map<string, HistEntry>();
  for (const l of lines) {
    const key = String(l.doc_number).trim();
    if (!key) continue;
    let e = idx.get(key);
    if (!e) {
      e = { po: l.po, lines: [] };
      idx.set(key, e);
    }
    e.lines.push(l);
  }
  return idx;
}

/**
 * Picks an unused history line with the same SKU and price, preferring the same quantity.
 * A line at a different price is never used: the order-line number matters exactly when
 * one SKU appears at several prices, so borrowing another price's line would be wrong.
 */
export function findHistLine(hist: HistEntry | undefined, sku: string, price: number, qty: number, used: Set<number>): HistLine | null {
  if (!hist) return null;
  const pool = hist.lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => !used.has(i) && String(l.sku) === String(sku) && Math.abs(l.price - price) < 0.005);
  const byQty = pool.filter(({ l }) => Math.abs(l.qty - qty) < 0.005);
  const pick = (byQty.length ? byQty : pool)[0];
  if (!pick) return null;
  used.add(pick.i);
  return pick.l;
}

export interface LineOverride {
  po?: string;
  line?: string;
}

export interface ResolvedLine {
  l: PortalLine;
  req: boolean;
  po: string;
  line: string;
  src: 'ידני' | 'היסטוריה' | 'נדרש' | 'לא נדרש';
}

export const lineKey = (rowKey: string, idx: number): string => `${rowKey}#${idx}`;

/** For every exportable line: order number, order-line number, and where they came from. */
export function resolveLines(r: MatchRow, history: Map<string, HistEntry>, overrides: Record<string, LineOverride>): ResolvedLine[] {
  const hist = history.get(String(r.dn).trim());
  const used = new Set<number>();
  const need = lineNoRequired(r);
  return exportableLines(r).map((l, idx) => {
    const req = need.has(l.sku);
    // Consume the history match even when overridden, so later lines keep their matches.
    const h = findHistLine(hist, l.sku, l.price, l.qty, used);
    const histPo = h ? h.po || hist?.po || '' : '';
    const ov = overrides[lineKey(r.key, idx)];
    if (ov && (ov.po || ov.line)) return { l, req, po: ov.po || histPo || r.po || '', line: ov.line || '', src: 'ידני' };
    if (h) return { l, req, po: histPo || r.po || '', line: h.line_no == null ? '' : String(h.line_no), src: 'היסטוריה' };
    return { l, req, po: r.po || '', line: '', src: req ? 'נדרש' : 'לא נדרש' };
  });
}

export interface InvoiceCsvLine {
  inv_no: string;
  alloc: string;
  site_code: string;
  inv_date: string;
  sku: string;
  qty: number;
  price: number;
  dn: string;
  po: string;
  line_no: string;
}

export interface MatchExport {
  /** CSV body without BOM (rows joined by \n). */
  csv: string;
  lines: InvoiceCsvLine[];
  /** Selected rows that are not "ok" — never exported. */
  blocked: MatchRow[];
  /** Selected ok rows whose lines are all below MIN_LINE_PRICE. */
  emptied: MatchRow[];
  /** Rows actually exported. */
  exported: MatchRow[];
}

/**
 * Portal invoice interface (12 columns, no header):
 * 1 site | 2 invoice no | 3 allocation no | 4 debit/credit (always D) | 5 invoice date DD/MM/YY |
 * 6 SKU | 7 supplier SKU (empty) | 8 qty | 9 unit price | 10 delivery-note no |
 * 11 order no | 12 order line — 11–12 are filled only when the line needs them.
 */
export function buildMatchExport(
  rows: MatchRow[],
  selected: Set<string>,
  allocEdit: Record<string, string>,
  history: Map<string, HistEntry>,
  overrides: Record<string, LineOverride>,
  siteCodeByName: Record<string, string>,
): MatchExport {
  const blocked = rows.filter((r) => selected.has(r.invNo) && r.status !== 'ok');
  const exported = rows.filter((r) => r.status === 'ok' && selected.has(r.invNo));
  const emptied = exported.filter((r) => r.lines.length && !exportableLines(r).length);
  const lines: InvoiceCsvLine[] = [];
  const out: string[] = [];
  for (const r of exported) {
    const alloc = (allocEdit[r.invNo] !== undefined ? allocEdit[r.invNo] : r.alloc) || '';
    const code = r.siteCode || siteCodeByName[r.site] || '';
    for (const { l, po, line, req } of resolveLines(r, history, overrides)) {
      const outPo = req ? po : '';
      const outLine = req ? line : '';
      out.push([code, r.invNo, alloc, 'D', r.date, l.sku, '', l.qty, l.price, r.dn, outPo, outLine].join(','));
      lines.push({ inv_no: r.invNo, alloc, site_code: code, inv_date: r.date, sku: l.sku, qty: l.qty, price: l.price, dn: r.dn, po: outPo, line_no: outLine });
    }
  }
  return { csv: out.join('\n'), lines, blocked, emptied, exported };
}

/** Exported invoices that contribute at least one line to the file (these get a PDF). */
export const withLines = (ex: MatchExport): MatchRow[] => ex.exported.filter((r) => !ex.emptied.includes(r));

/** Invoice PDF name in the package: the letter I followed by the invoice number. */
export function invPdfName(invNo: string): string {
  return 'I' + String(invNo).trim().replace(/^[iI]/, '') + '.pdf';
}

/** Picks the uploaded PDF for an invoice, if any. */
export function findInvoicePdf(fileNames: string[], invNo: string): string | undefined {
  return fileNames.find((n) => docNumsMatch(extractDocNum(n), invNo, 'i'));
}

const q = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;

/** Stand-alone errors file ("⬇ הורד קובץ שגויים"). */
export function errorsCsvFull(rows: MatchRow[], allocEdit: Record<string, string>): string {
  const bad = rows.filter((r) => r.status !== 'ok');
  const head = ['סוג שגיאה', 'מספר חשבונית', 'מספר הקצאה', 'תעודת משלוח', 'אתר', 'תאריך', 'סכום בדוח שלנו', 'סכום בפורטל לפני מעמ', 'סכום בפורטל כולל מעמ', 'הפרש'];
  const body = bad.map((r) =>
    [
      r.status === 'missing' ? 'תעודת משלוח לא נמצאה בפורטל' : 'הפרש בסכום',
      r.invNo,
      (allocEdit[r.invNo] !== undefined ? allocEdit[r.invNo] : r.alloc) || '',
      r.dn,
      r.site || '',
      r.date,
      r.amount.toFixed(2),
      r.portalNet === null ? '' : r.portalNet.toFixed(2),
      r.portalGross === null ? '' : r.portalGross.toFixed(2),
      r.diff === null ? '' : r.diff.toFixed(2),
    ]
      .map(q)
      .join(','),
  );
  return '﻿' + [head.map(q).join(','), ...body].join('\n');
}

/** Errors file included inside the package ZIP. */
export function errorsCsvPackage(rows: MatchRow[]): string {
  const bad = rows.filter((r) => r.status !== 'ok');
  const head = ['סוג שגיאה', 'מספר חשבונית', 'תעודת משלוח', 'אתר', 'סכום שלנו', 'פורטל כולל מעמ', 'הפרש'];
  const body = bad.map((r) =>
    [
      r.status === 'missing' ? 'לא נמצאה בפורטל' : 'הפרש בסכום',
      r.invNo,
      r.dn,
      r.site || '',
      r.amount.toFixed(2),
      r.portalGross === null ? '' : r.portalGross.toFixed(2),
      r.diff === null ? '' : r.diff.toFixed(2),
    ]
      .map(q)
      .join(','),
  );
  return '﻿' + [head.map(q).join(','), ...body].join('\n');
}
