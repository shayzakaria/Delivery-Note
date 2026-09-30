import { describe, expect, it } from 'vitest';
import {
  buildHistoryIndex,
  buildMatchExport,
  errorsCsvFull,
  errorsCsvPackage,
  findInvoicePdf,
  headerIndex,
  invPdfName,
  lineKey,
  exportedGross,
  findHistLine,
  newestFirst,
  lineNoRequired,
  linesMatchInvoice,
  parseInvoiceReport,
  parsePortalDN,
  resolveLines,
  runMatch,
  SheetFormatError,
  withLines,
  zeroQtyLines,
  type HistLine,
} from './invoiceMatch';
import { xlsxBytes } from './testSheets';
import { parseWorkbook } from './xlsxParse';

const PORTAL_HEADER = ['אתר', 'חברה', 'תאריך', 'תעודה סולל', 'תעודת ספק', 'סטטוס', 'מקט', 'מקט יצרן', 'תאור', 'כמות ספק', 'כמות שהתקבלה', 'מחיר יחידה', 'מטבע', 'סהכ מחיר', 'הערה'];
const pRow = (dn: number, sku: number, qty: number, price: number, site = 'אתר א') =>
  [site, 'חברה', new Date(2026, 4, 24), 'GR1', dn, 'מאושר(סופית)', sku, null, 'תיאור', qty, qty, price, 'ש"ח', qty * price, null];

const INV_HEADER = ['מספר כרטיס', 'שם כרטיס', 'קוד לקוח', 'שם לקוח', 'מספר חשבונית', 'סכום חשבונית', 'תאריך חשבונית', 'מספר הקצאה', 'תקופת מאזן', 'תעודה פיננסית', 'תעודת משלוח', 'הזמנת שו"ב', 'מס.פרוייקט שו"ב', 'הערת פרטים 2'];
const iRow = (inv: number, amount: number, dn: number, po: string | null, site: string, alloc: string | null = null) =>
  [111, 'לקוח', '222', 'שם לקוח', inv, amount, new Date(2026, 3, 30), alloc, 2026, 999, dn, po, site, null];

const portal = parsePortalDN(
  parseWorkbook(
    xlsxBytes([
      PORTAL_HEADER,
      pRow(100, 5001, 1, 100), // DN 100 → 100 net
      pRow(200, 7001, 1, 108), // DN 200: same SKU at three prices, one below ₪1
      pRow(200, 7001, 1, 0.01),
      pRow(200, 7001, 1, 540),
      pRow(300, 8001, 2, 0), // DN 300: only zero-price lines
      pRow(400, 9001, 3, 50), // DN 400 → 150 net
    ]),
  ),
);

const invoices = parseInvoiceReport(
  parseWorkbook(
    xlsxBytes([
      INV_HEADER,
      iRow(300000011, 118, 100, 'PO100', '10000080'),
      iRow(300000012, 765, 200, 'PO200', '10000074', '900000001'),
      iRow(300000013, 1475, 999, null, '10000074'),
      iRow(300000014, 0, 300, 'PO300', '10000074'),
      iRow(300000015, 200, 400, 'PO400', '10000074'),
    ]),
  ),
);

describe('file parsing', () => {
  it('groups the portal report by delivery note with net totals', () => {
    expect([...portal.keys()]).toEqual(['100', '200', '300', '400']);
    expect(portal.get('200')!.total).toBeCloseTo(648.01, 6);
    expect(portal.get('200')!.rows.map((r) => r.price)).toEqual([108, 0.01, 540]);
    expect(portal.get('100')!.site).toBe('אתר א');
  });

  it('reads the invoice report, including dates as DD/MM/YY', () => {
    expect(invoices[0]).toEqual({ invNo: '300000011', dn: '100', amount: 118, date: '30/04/26', alloc: '', po: 'PO100', siteCode: '10000080', custName: 'שם לקוח' });
    expect(invoices[1].alloc).toBe('900000001');
  });

  it('finds headers even with quote variations and extra rows above', () => {
    const h = headerIndex([['כותרת'], [], ['הזמנת שוב', 'מספר חשבונית', 'תעודת משלוח']], {
      invNo: ['מספר חשבונית'],
      dn: ['תעודת משלוח'],
      po: ['הזמנת שו"ב'],
    });
    expect(h).toEqual({ row: 2, idx: { invNo: 1, dn: 2, po: 0 } });
  });

  it('rejects files without the key columns', () => {
    expect(() => parsePortalDN({ rows: [['a', 'b']], date1904: false })).toThrow(SheetFormatError);
    expect(() => parseInvoiceReport({ rows: [['a', 'b']], date1904: false })).toThrow(SheetFormatError);
  });
});

describe('matching', () => {
  const { rows, siteCodeByName } = runMatch(portal, invoices, 18, 1);

  it('classifies invoices against portal totals plus VAT', () => {
    expect(rows.map((r) => [r.invNo, r.status])).toEqual([
      ['300000011', 'ok'], // 100 × 1.18 = 118
      ['300000012', 'ok'], // 648.01 × 1.18 = 764.65, within ₪1 of 765
      ['300000013', 'missing'],
      ['300000014', 'ok'],
      ['300000015', 'diff'], // 150 × 1.18 = 177 vs 200
    ]);
    expect(rows[1].diff).toBeCloseTo(765 - 764.6518, 3);
    expect(siteCodeByName['אתר א']).toBeDefined();
  });

  it('respects the tolerance and VAT settings', () => {
    expect(runMatch(portal, invoices, 18, 0.1).rows[1].status).toBe('diff');
    expect(runMatch(portal, invoices, 0, 1).rows[0].status).toBe('diff');
  });

  it('requires order-line numbers only for SKUs repeated at different prices (≥ ₪1)', () => {
    expect([...lineNoRequired(rows[1])]).toEqual(['7001']);
    expect([...lineNoRequired(rows[0])]).toEqual([]);
  });

  it('fills order-line numbers from the delivery history, per line and per order', () => {
    const hist: HistLine[] = [
      { doc_number: '200', po: 'PO200', line_no: 4, sku: '7001', qty: 1, price: 108 },
      { doc_number: '200', po: 'PO201', line_no: 9, sku: '7001', qty: 1, price: 540 },
    ];
    const res = resolveLines(rows[1], buildHistoryIndex(hist), {});
    expect(res.map((r) => [r.l.price, r.po, r.line, r.src, r.req])).toEqual([
      [108, 'PO200', '4', 'היסטוריה', true],
      [540, 'PO201', '9', 'היסטוריה', true], // the second order is kept, not overwritten by the first
    ]);
  });

  it('never borrows a line number from a different price', () => {
    const hist = buildHistoryIndex([{ doc_number: '200', po: 'PO200', line_no: 4, sku: '7001', qty: 1, price: 108 }]);
    const res = resolveLines(rows[1], hist, {});
    expect(res.map((r) => [r.l.price, r.line, r.src])).toEqual([
      [108, '4', 'היסטוריה'],
      [540, '', 'נדרש'], // the ₪108 line must not be reused for the ₪540 line
    ]);
    expect(findHistLine(hist.get('200'), '7001', 540, 1, new Set())).toBeNull();
  });

  it('keeps the history order number when a line number is typed over it', () => {
    const hist = buildHistoryIndex([
      { doc_number: '200', po: 'PO-H', line_no: 4, sku: '7001', qty: 1, price: 108 },
      { doc_number: '200', po: 'PO-H', line_no: 9, sku: '7001', qty: 1, price: 540 },
    ]);
    const res = resolveLines(rows[1], hist, { [lineKey(rows[1].key, 0)]: { line: '7' } });
    expect(res.map((r) => [r.po, r.line, r.src])).toEqual([
      ['PO-H', '7', 'ידני'],
      ['PO-H', '9', 'היסטוריה'],
    ]);
  });

  it('prefers the newest export of a delivery note (a corrected re-export wins)', () => {
    const lines = [
      { doc_number: '200', po: 'PO200', line_no: 3, sku: '7001', qty: 1, price: 540, created_at: '2026-09-01T10:00:00Z' },
      { doc_number: '200', po: 'PO200', line_no: 4, sku: '7001', qty: 1, price: 108, created_at: '2026-09-01T10:00:00Z' },
      { doc_number: '200', po: 'PO200', line_no: 7, sku: '7001', qty: 1, price: 540, created_at: '2026-09-02T08:00:00Z' },
    ];
    const res = resolveLines(rows[1], buildHistoryIndex(newestFirst(lines)), {});
    expect(res.map((r) => [r.l.price, r.line])).toEqual([
      [108, '4'],
      [540, '7'],
    ]);
  });

  it('keeps an emptied manual line number empty instead of snapping back to history', () => {
    const hist = buildHistoryIndex([{ doc_number: '200', po: 'PO200', line_no: 4, sku: '7001', qty: 1, price: 108 }]);
    const res = resolveLines(rows[1], hist, { [lineKey(rows[1].key, 0)]: { line: '' } });
    expect([res[0].line, res[0].src]).toEqual(['', 'ידני']);
  });

  it('lets manual overrides win over history', () => {
    const res = resolveLines(rows[1], buildHistoryIndex([]), { [lineKey(rows[1].key, 1)]: { line: '12' } });
    expect(res.map((r) => [r.line, r.src])).toEqual([
      ['', 'נדרש'],
      ['12', 'ידני'],
    ]);
  });
});

describe('invoice CSV', () => {
  const { rows, siteCodeByName } = runMatch(portal, invoices, 18, 1);
  const hist = buildHistoryIndex([{ doc_number: '200', po: 'PO200', line_no: 4, sku: '7001', qty: 1, price: 108 }]);

  it('writes only selected ok invoices, in the 12-column layout', () => {
    const sel = new Set(['300000011', '300000012', '300000013', '300000015', '300000014']);
    const ex = buildMatchExport(rows, sel, { '300000011': '555' }, hist, { [lineKey(rows[1].key, 1)]: { line: '5' } }, siteCodeByName);
    expect(ex.csv).toBe(
      [
        '10000080,300000011,555,D,30/04/26,5001,,1,100,100,,',
        '10000074,300000012,900000001,D,30/04/26,7001,,1,108,200,PO200,4',
        '10000074,300000012,900000001,D,30/04/26,7001,,1,540,200,PO200,5',
      ].join('\n'),
    );
    expect(ex.blocked.map((r) => r.invNo)).toEqual(['300000013', '300000015']);
    expect(ex.emptied.map((r) => r.invNo)).toEqual(['300000014']);
    expect(ex.exported.map((r) => r.invNo)).toEqual(['300000011', '300000012', '300000014']);
    expect(ex.lines[1]).toEqual({ inv_no: '300000012', alloc: '900000001', site_code: '10000074', inv_date: '30/04/26', sku: '7001', qty: 1, price: 108, dn: '200', po: 'PO200', line_no: '4' });
  });

  it('checks that the exported lines add up to the invoice', () => {
    expect(linesMatchInvoice(rows[0], 18, 1)).toBe(true); // 100 × 1.18 = 118
    // DN 200 drops its ₪0.01 line: 648 × 1.18 = 764.64 vs 765 — still within ₪1
    expect(exportedGross(rows[1], 18)).toBeCloseTo(764.64, 6);
    expect(linesMatchInvoice(rows[1], 18, 0.2)).toBe(false);
    expect(zeroQtyLines(rows[0])).toEqual([]);
  });

  it('packages PDFs only for invoices that have lines in the file', () => {
    const ex = buildMatchExport(rows, new Set(['300000011', '300000014']), {}, hist, {}, siteCodeByName);
    expect(ex.emptied.map((r) => r.invNo)).toEqual(['300000014']);
    expect(withLines(ex).map((r) => r.invNo)).toEqual(['300000011']);
  });

  it('names and finds invoice PDFs', () => {
    expect(invPdfName('300000001')).toBe('I300000001.pdf');
    expect(invPdfName('i300000001')).toBe('I300000001.pdf');
    expect(findInvoicePdf(['x.pdf', 'i300000001.PDF'], '300000001')).toBe('i300000001.PDF');
    expect(findInvoicePdf(['S300000001.pdf'], '300000001')).toBeUndefined(); // a delivery-note scan is not an invoice
  });

  it('builds both error files', () => {
    const full = errorsCsvFull(rows, {});
    expect(full.startsWith('﻿"סוג שגיאה","מספר חשבונית","מספר הקצאה"')).toBe(true);
    expect(full).toContain('"תעודת משלוח לא נמצאה בפורטל","300000013","","999","","30/04/26","1475.00","","",""');
    expect(full).toContain('"הפרש בסכום","300000015","","400","אתר א","30/04/26","200.00","150.00","177.00","23.00"');
    const pkg = errorsCsvPackage(rows);
    expect(pkg.split('\n')).toHaveLength(3);
    expect(pkg).toContain('"לא נמצאה בפורטל","300000013","999","","1475.00","",""');
  });
});
