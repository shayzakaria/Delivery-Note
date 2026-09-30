export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Today's date in the user's local timezone as YYYY-MM-DD. */
export function todayISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** DD-MM-YYYY — the stamp used for exported file and folder names. */
export function fileStamp(d: Date = new Date()): string {
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** YYYY-MM-DD → DD/MM/YY, the date format the portal expects in uploaded files. */
export function isoToDDMMYY(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1].slice(-2)}`;
}

/** YYYY-MM-DD → DD/MM/YYYY for display. */
export function isoToDisplay(iso: string | null | undefined): string {
  if (!iso) return '–';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Timestamp → "DD/MM/YYYY HH:MM" in local time. */
export function dateTimeDisplay(ts: string | Date): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Money for display: ₪1,234.50 */
export function ils(n: number | null | undefined): string {
  return '₪' + (n || 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Quantity for display. */
export function qtyDisplay(n: number): string {
  return n.toLocaleString('he-IL', { maximumFractionDigits: 3 });
}

/** Removes binary floating noise (0.30000000000000004 → 0.3) without touching real precision. */
export function cleanNum(x: number): number {
  return Number.isFinite(x) ? parseFloat(x.toFixed(9)) : 0;
}

/**
 * Parses a user-typed quantity. Commas are accepted only as thousands separators
 * ("1,200" → 1200, as the app displays numbers); any other comma is ambiguous and
 * makes the value invalid (NaN), as does anything that is not a plain non-negative number.
 */
export function parseQty(raw: string): number {
  let s = raw.trim();
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return NaN;
    s = s.replace(/,/g, '');
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return NaN;
  return cleanNum(parseFloat(s));
}
