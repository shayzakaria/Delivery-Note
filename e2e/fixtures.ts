// Synthetic spreadsheets and PDFs for the E2E tests (no real business data).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function writeXlsx(path: string, aoa: unknown[][]) {
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: 'dd/mm/yy' });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  writeFileSync(path, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
  return path;
}

function ooRow(site: number, siteName: string, po: string, desc: string, buyer: string, sku: number, item: string, balance: number, price: number) {
  const r: unknown[] = new Array(18).fill(null);
  r[0] = site;
  r[1] = siteName;
  r[2] = 'חברה';
  r[3] = new Date(2026, 0, 6);
  r[4] = po;
  r[5] = desc;
  r[6] = buyer;
  r[9] = sku;
  r[11] = item;
  r[12] = balance;
  r[13] = balance;
  r[15] = price;
  r[17] = balance * price;
  return r;
}

export function openOrdersFile(dir: string) {
  return writeXlsx(join(dir, 'open-orders.xlsx'), [
    ['אתר', 'שם אתר', 'חברה', 'תאריך', 'הזמנה', 'פרטים', 'קניין', 'סטטוס', 'x', 'מקט', 'x', 'תאור', 'כמות', 'למשלוח', 'x', 'מחיר', 'x', 'סהכ'],
    ooRow(10000074, 'אתר צפון', 'PO202600000101', 'דירה 8', 'קניין א', 5000000005, 'פריט סגור', 0, 10),
    ooRow(10000074, 'אתר צפון', 'PO202600000101', 'דירה 8', 'קניין א', 5000000001, 'נקודת מים', 1, 40),
    ooRow(10000074, 'אתר צפון', 'PO202600000202', 'דירה 147', 'קניין א', 5000000002, 'חיפוי חדרים רטובים', 10, 60),
    ooRow(10000074, 'אתר צפון', 'PO202600000202', 'דירה 147', 'קניין א', 5000000004, 'כיור', 1, 108),
    ooRow(10000074, 'אתר צפון', 'PO202600000202', 'דירה 147', 'קניין א', 5000000004, 'כיור שדרוג', 1, 540),
    ooRow(10000080, 'אתר דרום', 'PO202600000404', 'השלמה להזמנה', 'קניין ב', 5000000003, 'חיפוי לובי', 37, 171),
  ]);
}

export function portalReportFile(dir: string) {
  const H = ['אתר', 'חברה', 'תאריך', 'תעודה סולל', 'תעודת ספק', 'סטטוס', 'מקט', 'מקט יצרן', 'תאור', 'כמות ספק', 'כמות שהתקבלה', 'מחיר יחידה', 'מטבע', 'סהכ מחיר', 'הערה'];
  const r = (dn: number, sku: number, qty: number, price: number) => ['אתר צפון', 'חברה', new Date(2026, 7, 23), 'GR1', dn, 'מאושר(סופית)', sku, null, 'x', qty, qty, price, 'ש"ח', qty * price, null];
  return writeXlsx(join(dir, 'portal.xlsx'), [H, r(700000002, 5000000004, 1, 108), r(700000002, 5000000004, 1, 540), r(700000002, 5000000002, 4.08, 60), r(700000001, 5000000001, 1, 40)]);
}

export function invoiceReportFile(dir: string) {
  const H = ['מספר כרטיס', 'שם כרטיס', 'קוד לקוח', 'שם לקוח', 'מספר חשבונית', 'סכום חשבונית', 'תאריך חשבונית', 'מספר הקצאה', 'תקופת מאזן', 'תעודה פיננסית', 'תעודת משלוח', 'הזמנת שו"ב', 'מס.פרוייקט שו"ב', 'הערת פרטים 2'];
  const r = (inv: number, amount: number, dn: number, po: string) => [1, 'x', '2', 'x', inv, amount, new Date(2026, 8, 1), null, 2026, 9, dn, po, '10000074', null];
  // 700000002: (108 + 540 + 244.8) × 1.18 = 1053.504 → 1053.5 is within ₪1
  return writeXlsx(join(dir, 'invoices.xlsx'), [H, r(300000001, 1053.5, 700000002, 'PO202600000202'), r(300000002, 47.2, 700000001, 'PO202600000101'), r(300000003, 99, 700000099, 'PO1')]);
}

/** A folder of small PDF files (content is irrelevant to the app). */
export function pdfFolder(dir: string, names: string[]) {
  const folder = join(dir, '323');
  mkdirSync(folder, { recursive: true });
  for (const n of names) writeFileSync(join(folder, n), `%PDF-1.4\n% ${n}\n%%EOF\n`);
  return folder;
}

export function readZip(path: string): { names: string[]; files: Record<string, string> } {
  const script = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({"names": z.namelist(), "files": {n: z.read(n).decode("utf-8", "replace") for n in z.namelist()}}))`;
  return JSON.parse(execFileSync('python3', ['-c', script, path], { encoding: 'utf8' }));
}
