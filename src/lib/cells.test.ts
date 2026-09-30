import { describe, expect, it } from 'vitest';
import { isPresent, serialToISO, text, toISODate, toInt, toNumber } from './cells';
import { cleanNum, fileStamp, isoToDDMMYY, parseQty, todayISO } from './format';

describe('cell conversion', () => {
  it('reads numbers from numeric and formatted-text cells', () => {
    expect(toNumber(4.08)).toBe(4.08);
    expect(toNumber('4.08')).toBe(4.08);
    // The production app used parseFloat on display text, which turns "1,000.00" into 1.
    expect(toNumber('1,000.00')).toBe(1000);
    expect(toNumber('₪ 60')).toBe(60);
    expect(toNumber(0.1 + 0.2)).toBe(0.3);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('')).toBe(0);
    expect(toNumber('abc')).toBe(0);
  });

  it('parses site codes like parseInt', () => {
    expect(toInt(10000074)).toBe(10000074);
    expect(toInt('10000074')).toBe(10000074);
    expect(toInt('אתר')).toBe(0);
  });

  it('prints numeric text the way JavaScript does', () => {
    expect(text(5000000001)).toBe('5000000001');
    expect(text('  PO202600000101 ')).toBe('PO202600000101');
    expect(text(null)).toBe('');
  });

  it('treats empty and zero cells as absent', () => {
    expect(isPresent('x')).toBe(true);
    expect(isPresent(5)).toBe(true);
    expect(isPresent('')).toBe(false);
    expect(isPresent(null)).toBe(false);
    expect(isPresent(0)).toBe(false);
  });

  it('converts Excel serial dates without timezone drift', () => {
    expect(serialToISO(46028)).toBe('2026-01-06');
    expect(serialToISO(46028.99)).toBe('2026-01-06');
    expect(serialToISO(44562, true)).toBe('2026-01-02');
    expect(serialToISO(0)).toBeNull();
  });

  it('reads Israeli-style and ISO text dates', () => {
    expect(toISODate('06/01/2026')).toBe('2026-01-06');
    expect(toISODate('6/1/26')).toBe('2026-01-06');
    expect(toISODate(' 30/04/26')).toBe('2026-04-30');
    expect(toISODate('2026-01-06T00:00:00')).toBe('2026-01-06');
    expect(toISODate('31/02/2026')).toBeNull();
    expect(toISODate('לא תאריך')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats portal and file dates', () => {
    expect(isoToDDMMYY('2026-08-01')).toBe('01/08/26');
    expect(isoToDDMMYY('')).toBe('');
    expect(fileStamp(new Date(2026, 7, 23, 9, 7))).toBe('23-08-2026');
  });

  it('uses the local date, not UTC', () => {
    // 00:30 local on 1 Sep — toISOString() would give 31 Aug in Israel.
    expect(todayISO(new Date(2026, 8, 1, 0, 30))).toBe('2026-09-01');
  });

  it('parses typed quantities strictly', () => {
    expect(parseQty('4.08')).toBe(4.08);
    expect(parseQty('37')).toBe(37);
    expect(parseQty('4,5')).toBe(4.5);
    expect(parseQty('')).toBeNaN();
    expect(parseQty('-1')).toBeNaN();
    expect(parseQty('1e3')).toBeNaN();
    expect(cleanNum(244.79999999999998)).toBe(244.8);
  });
});
