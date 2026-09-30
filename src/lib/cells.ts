import { cleanNum, pad2 } from './format';

/** A spreadsheet cell after parsing (dates arrive as Excel serial numbers). */
export type Cell = string | number | boolean | null;
export type Row = Cell[];

/** Parsed first sheet of a workbook. */
export interface SheetData {
  rows: Row[];
  /** Workbook uses the 1904 date system (old Mac Excel). */
  date1904: boolean;
}

/**
 * Whether a cell has any value. Like the original (which read display text), the
 * number 0 counts as present — so a row with site code 0 is still counted for line
 * numbering and is then rejected by validation instead of silently shifting lines.
 */
export function isPresent(v: Cell | undefined): boolean {
  return v !== null && v !== undefined && v !== '';
}

/** Cell → trimmed text. Numbers are printed the way JavaScript prints them (10000074 → "10000074"). */
export function text(v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * Cell → number. Numeric cells are used as-is (minus float noise); text cells are
 * stripped of everything except digits, dot and minus ("1,000.00" → 1000, "₪ 60" → 60).
 */
export function toNumber(v: Cell | undefined): number {
  if (typeof v === 'number') return cleanNum(v);
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isNaN(n) ? 0 : cleanNum(n);
}

/** Leading integer of a cell, like parseInt ("10000074" → 10000074, "abc" → 0). */
export function toInt(v: Cell | undefined): number {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(text(v), 10);
  return Number.isNaN(n) ? 0 : n;
}

const MS_PER_DAY = 86_400_000;
const EXCEL_EPOCH_1900 = Date.UTC(1899, 11, 30);
const EXCEL_EPOCH_1904 = Date.UTC(1904, 0, 1);

/** Excel serial date → YYYY-MM-DD (time of day is ignored). */
export function serialToISO(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465) return null;
  const epoch = date1904 ? EXCEL_EPOCH_1904 : EXCEL_EPOCH_1900;
  const d = new Date(epoch + Math.floor(serial + 1e-7) * MS_PER_DAY);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Date cell → YYYY-MM-DD. Accepts Excel serials, ISO strings and Israeli-style
 * DD/MM/YYYY or DD/MM/YY text. Returns null when the value is not a recognizable date.
 */
export function toISODate(v: Cell | undefined, date1904 = false): string | null {
  if (typeof v === 'number') return serialToISO(v, date1904);
  const t = text(v);
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return validYMD(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(t.split(/\s+/)[0]);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validYMD(y, +m[2], +m[1]);
  }
  return null;
}

function validYMD(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}
