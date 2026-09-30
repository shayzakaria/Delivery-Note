import * as XLSX from 'xlsx';
import type { Cell, Row, SheetData } from './cells';

const MAX_ROWS = 200_000;

/**
 * Reads the first sheet of an .xlsx/.xls file into rows of raw cell values.
 * Dates stay Excel serial numbers; converting them is up to the caller, which
 * knows which columns hold dates.
 */
export function parseWorkbook(data: ArrayBuffer | Uint8Array): SheetData {
  const wb = XLSX.read(data instanceof Uint8Array ? data : new Uint8Array(data), {
    type: 'array',
    cellDates: false,
    cellHTML: false,
    cellFormula: false,
  });
  const name = wb.SheetNames[0];
  if (!name) return { rows: [], date1904: false };
  const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  const rows: Row[] = [];
  for (const r of raw.slice(0, MAX_ROWS)) {
    rows.push(Array.isArray(r) ? r.map(sanitizeCell) : []);
  }
  const date1904 = Boolean((wb as { Workbook?: { WBProps?: { date1904?: boolean } } }).Workbook?.WBProps?.date1904);
  return { rows, date1904 };
}

function sanitizeCell(v: unknown): Cell {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  return null;
}
