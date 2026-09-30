import { describe, expect, it } from 'vitest';
import { groupByPo, matchesQuery, parseOpenOrders } from './openOrders';
import { OPEN_ORDERS_HEADER, openOrderRow, xlsxBytes } from './testSheets';
import { parseWorkbook } from './xlsxParse';

function sheet() {
  return parseWorkbook(
    xlsxBytes([
      ['דוח הזמנות פתוחות'],
      OPEN_ORDERS_HEADER,
      openOrderRow({ site: 10000074, date: new Date(2026, 0, 6), po: 'PO202600000101', desc: 'דירה 8', sku: 5000000005, balance: 0, price: 10 }),
      openOrderRow({ site: 10000074, date: new Date(2026, 0, 6), po: 'PO202600000101', desc: 'דירה 8', sku: 5000000006, balance: 2, price: 40, total: 80 }),
      openOrderRow({ site: 10000080, siteName: 'אתר ב', po: 'PO202600000404', desc: 'השלמה', sku: '5000000003', balance: '37', price: '1,171.50' }),
      openOrderRow({ site: 10000074, date: '23/08/2026', po: 'PO202600000101', desc: 'דירה 8', sku: 5000000001, balance: 1, price: 40 }),
      [null, null, null, null, null, null, null, null, null, null, null, null, null, 999],
      ['סה"כ', null, null, null, null, null, null, null, null, null, null, null, null, 40],
    ]),
  );
}

describe('parseOpenOrders', () => {
  const lines = parseOpenOrders(sheet());

  it('keeps only lines with something left to deliver', () => {
    expect(lines.map((l) => `${l.po}:${l.line_no}`)).toEqual(['PO202600000101:2', 'PO202600000404:1', 'PO202600000101:3']);
  });

  it('numbers lines per order before dropping closed ones', () => {
    // line 1 of PO…101 is fully delivered, so the open lines stay 2 and 3
    expect(lines.filter((l) => l.po === 'PO202600000101').map((l) => l.line_no)).toEqual([2, 3]);
  });

  it('reads values by column position', () => {
    const l = lines[0];
    expect(l).toMatchObject({
      site_code: 10000074,
      site_name: 'אתר בדיקה',
      order_date: '2026-01-06',
      po_desc: 'דירה 8',
      buyer: 'קניין',
      sku: '5000000006',
      item_desc: 'פריט',
      qty_ordered: 2,
      balance: 2,
      price: 40,
      line_total: 80,
    });
  });

  it('handles numbers stored as formatted text and text dates', () => {
    expect(lines[1]).toMatchObject({ site_code: 10000080, sku: '5000000003', balance: 37, price: 1171.5 });
    expect(lines[2].order_date).toBe('2026-08-23');
  });

  it('groups orders in file order and searches like the production app', () => {
    const groups = groupByPo(lines);
    expect(groups.map((g) => g.po)).toEqual(['PO202600000101', 'PO202600000404']);
    expect(groups[0].lines).toHaveLength(2);
    const g = groups[0];
    expect(matchesQuery(g, '101')).toBe(true);
    expect(matchesQuery(g, '0101')).toBe(true);
    expect(matchesQuery(g, 'דירה 8')).toBe(true);
    expect(matchesQuery(g, '8')).toBe(true); // matches the description
    expect(matchesQuery(g, '26')).toBe(true); // plain substring of the order number
    expect(matchesQuery(g, '99')).toBe(false);
    expect(matchesQuery(g, '0-1-0-1')).toBe(true); // digits-only match needs ≥ 3 digits
    expect(matchesQuery(g, '9-9')).toBe(false);
    expect(matchesQuery(g, 'po2026')).toBe(true);
    expect(matchesQuery(g, '')).toBe(true);
  });
});
