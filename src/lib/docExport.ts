import { fileStamp, isoToDDMMYY } from './format';
import type { PoLine } from './openOrders';

export type DocKind = 'delivery' | 'invoice_manual';

export interface DocKindConfig {
  kind: DocKind;
  /** Folder / zip suffix: DD-MM-YYYY_<suffix> */
  folderSuffix: string;
  /** Prefix shown in the expected PDF name hint. */
  pdfPrefix: string;
  docLabel: string;
  docLabelShort: string;
  missingDocLabel: string;
  qtyColumnLabel: string;
}

export const DOC_KINDS: Record<DocKind, DocKindConfig> = {
  delivery: {
    kind: 'delivery',
    folderSuffix: 'משלוחים',
    pdfPrefix: 'S',
    docLabel: "מס' תעודת משלוח",
    docLabelShort: 'תעודה',
    missingDocLabel: 'חסר מספר תעודה',
    qtyColumnLabel: 'כמות לאספקה',
  },
  invoice_manual: {
    kind: 'invoice_manual',
    folderSuffix: 'חשבוניות',
    pdfPrefix: 'i',
    docLabel: 'מס׳ חשבונית',
    docLabelShort: 'חשבונית',
    missingDocLabel: 'חסר מספר חשבונית',
    qtyColumnLabel: 'כמות לחשבונית',
  },
};

/** One selected order: its document number/date and the chosen lines with quantities. */
export interface DocSelection {
  po: string;
  docNumber: string;
  /** YYYY-MM-DD */
  docDate: string;
  items: { line: PoLine; qty: number }[];
}

/**
 * Portal "קליטת משלוחים מקובץ" row (9 columns, no header):
 * site code, document number, date DD/MM/YY, SKU, manufacturer SKU (empty),
 * quantity, unit price, order number, order line number.
 */
export function docCsvRow(sel: DocSelection, item: { line: PoLine; qty: number }): string {
  const l = item.line;
  return [l.site_code, sel.docNumber.trim(), isoToDDMMYY(sel.docDate), l.sku, '', item.qty, l.price, sel.po, l.line_no].join(',');
}

export function buildDocCsv(selections: DocSelection[]): string {
  const rows: string[] = [];
  for (const sel of selections) for (const it of sel.items) rows.push(docCsvRow(sel, it));
  return '﻿' + rows.join('\n');
}

export function docExportNames(kind: DocKind, now: Date = new Date()) {
  const stamp = fileStamp(now);
  const folder = `${stamp}_${DOC_KINDS[kind].folderSuffix}`;
  return { stamp, folder, csvName: `${stamp}.csv`, zipName: `${folder}.zip`, csvPathInZip: `${folder}/${stamp}.csv` };
}

export interface SelectionIssues {
  /** Document numbers containing characters that would break the CSV (comma, quote, line break). */
  unsafeDoc: string[];
  /** Orders whose site code is missing or not a number. */
  badSite: string[];
  missingDoc: string[];
  missingDate: string[];
  invalidQty: { po: string; line_no: number }[];
  overBalance: { po: string; line_no: number; qty: number; balance: number }[];
  nonNumericDoc: string[];
}

export function validateSelections(selections: DocSelection[]): SelectionIssues {
  const issues: SelectionIssues = { unsafeDoc: [], badSite: [], missingDoc: [], missingDate: [], invalidQty: [], overBalance: [], nonNumericDoc: [] };
  for (const s of selections) {
    const doc = s.docNumber.trim();
    if (s.items.some((it) => !(it.line.site_code > 0))) issues.badSite.push(s.po);
    if (!doc) issues.missingDoc.push(s.po);
    else if (/[,"\r\n]/.test(doc)) issues.unsafeDoc.push(s.po);
    else if (!/^\d+$/.test(doc.replace(/^[sSiI]/, ''))) issues.nonNumericDoc.push(s.po);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.docDate)) issues.missingDate.push(s.po);
    for (const it of s.items) {
      if (!(it.qty > 0) || !Number.isFinite(it.qty)) issues.invalidQty.push({ po: s.po, line_no: it.line.line_no });
      else if (it.qty > it.line.balance + 1e-9) issues.overBalance.push({ po: s.po, line_no: it.line.line_no, qty: it.qty, balance: it.line.balance });
    }
  }
  return issues;
}

export function selectionTotal(selections: DocSelection[]): number {
  let t = 0;
  for (const s of selections) for (const it of s.items) t += it.qty * it.line.price;
  return t;
}
