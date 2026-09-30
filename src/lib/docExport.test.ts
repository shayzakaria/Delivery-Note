import { describe, expect, it } from 'vitest';
import { buildDocCsv, docExportNames, normalizeDocNumber, selectionTotal, validateSelections, type DocSelection } from './docExport';
import type { PoLine } from './openOrders';
import { matchPdfs, docNumsMatch } from './pdfMatch';

const line = (p: Partial<PoLine>): PoLine => ({
  po: 'PO1',
  line_no: 1,
  site_code: 10000074,
  site_name: 'אתר',
  order_date: null,
  po_desc: '',
  buyer: '',
  sku: '111',
  item_desc: 'פריט',
  qty_ordered: 1,
  balance: 1,
  price: 40,
  line_total: 40,
  ...p,
});

const selections: DocSelection[] = [
  {
    po: 'PO202600000101',
    docNumber: ' 700000001 ',
    docDate: '2026-08-01',
    items: [{ line: line({ po: 'PO202600000101', line_no: 15, sku: '5000000001', price: 40 }), qty: 1 }],
  },
  {
    po: 'PO202600000202',
    docNumber: '700000002',
    docDate: '2026-08-23',
    items: [{ line: line({ po: 'PO202600000202', line_no: 16, sku: '5000000002', price: 60, balance: 4.08 }), qty: 4.08 }],
  },
  {
    po: 'PO202600000404',
    docNumber: '700000003',
    docDate: '2026-08-23',
    items: [{ line: line({ po: 'PO202600000404', site_code: 10000080, line_no: 1, sku: '5000000003', price: 171, balance: 37 }), qty: 37 }],
  },
];

describe('delivery CSV', () => {
  it('matches the portal upload layout exactly (same shape as the guide screenshot)', () => {
    expect(buildDocCsv(selections)).toBe(
      '﻿' +
        [
          '10000074,700000001,01/08/26,5000000001,,1,40,PO202600000101,15',
          '10000074,700000002,23/08/26,5000000002,,4.08,60,PO202600000202,16',
          '10000080,700000003,23/08/26,5000000003,,37,171,PO202600000404,1',
        ].join('\n'),
    );
  });

  it('totals the selection like the portal summary', () => {
    expect(selectionTotal(selections)).toBeCloseTo(6611.8, 6);
  });

  it('names files by the export date', () => {
    const n = docExportNames('delivery', new Date(2026, 7, 23, 7, 2));
    expect(n).toEqual({
      stamp: '23-08-2026',
      folder: '23-08-2026_משלוחים',
      csvName: '23-08-2026.csv',
      zipName: '23-08-2026_משלוחים.zip',
      csvPathInZip: '23-08-2026_משלוחים/23-08-2026.csv',
    });
    expect(docExportNames('invoice_manual', new Date(2026, 7, 23)).folder).toBe('23-08-2026_חשבוניות');
  });

  it('flags missing documents, dates and bad quantities', () => {
    const bad: DocSelection[] = [
      { po: 'A', docNumber: '', docDate: '2026-08-01', items: [{ line: line({}), qty: 1 }] },
      { po: 'B', docNumber: '12x', docDate: '', items: [{ line: line({ line_no: 2 }), qty: 0 }] },
      { po: 'C', docNumber: 'S620', docDate: '2026-08-01', items: [{ line: line({ line_no: 3, balance: 2 }), qty: 3 }] },
    ];
    const v = validateSelections(bad);
    expect(v.missingDoc).toEqual(['A']);
    expect(v.nonNumericDoc).toEqual(['B', 'C']); // validation sees the number as it goes to the portal
    expect(v.missingDate).toEqual(['B']);
    expect(v.invalidQty).toEqual([{ po: 'B', line_no: 2 }]);
    expect(v.overBalance).toEqual([{ po: 'C', line_no: 3, qty: 3, balance: 2 }]);
  });

  it('drops the file-name prefix the user may copy from the scan name', () => {
    expect(normalizeDocNumber(' S700000001 ', 'S')).toBe('700000001');
    expect(normalizeDocNumber('s700000001', 'S')).toBe('700000001');
    expect(normalizeDocNumber('i300000001', 'i')).toBe('300000001');
    expect(normalizeDocNumber('I300000001', 'S')).toBe('I300000001'); // wrong prefix for this tab: left for validation
    expect(normalizeDocNumber('S', 'S')).toBe('S');
    expect(normalizeDocNumber('SX1', 'S')).toBe('SX1');
  });

  it('blocks values that would break the CSV and orders without a site code', () => {
    const v = validateSelections([
      { po: 'D', docNumber: '620,1', docDate: '2026-08-01', items: [{ line: line({}), qty: 1 }] },
      { po: 'E', docNumber: '6201', docDate: '2026-08-01', items: [{ line: line({ site_code: 0 }), qty: 1 }] },
    ]);
    expect(v.unsafeDoc).toEqual(['D']);
    expect(v.nonNumericDoc).toEqual([]);
    expect(v.badSite).toEqual(['E']);
  });
});

describe('PDF matching', () => {
  it('tolerates the S / I prefix and letter case', () => {
    expect(docNumsMatch('S700000001', '700000001')).toBe(true);
    expect(docNumsMatch('s700000001', '700000001')).toBe(true);
    expect(docNumsMatch('700000001', 'S700000001')).toBe(true);
    expect(docNumsMatch('I300000001', '300000001')).toBe(true);
    expect(docNumsMatch('S700000001', '62079923')).toBe(false);
    expect(docNumsMatch('X700000001', '700000001')).toBe(false);
    expect(docNumsMatch('S700000001', '')).toBe(false);
    // per-kind prefixes: delivery notes accept S only, invoices I only
    expect(docNumsMatch('S700000001', '700000001', 's')).toBe(true);
    expect(docNumsMatch('I700000001', '700000001', 's')).toBe(false);
    expect(docNumsMatch('i300000001', '300000001', 'i')).toBe(true);
    expect(docNumsMatch('S300000001', '300000001', 'i')).toBe(false);
  });

  it('classifies files as matched, unrelated, or missing', () => {
    const r = matchPdfs(['S700000001.pdf', 'S700000007.PDF', 'S700000003.pdf'], ['700000001', '700000003', '700000002', '700000001']);
    expect(r.matched).toEqual([
      { name: 'S700000001.pdf', doc: '700000001' },
      { name: 'S700000003.pdf', doc: '700000003' },
    ]);
    expect(r.unmatched).toEqual(['S700000007.PDF']);
    expect(r.missing).toEqual(['700000002']);
  });
});
