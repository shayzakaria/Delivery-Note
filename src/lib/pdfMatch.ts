/** File name without the .pdf extension. */
export function extractDocNum(filename: string): string {
  return filename.replace(/\.pdf$/i, '');
}

/**
 * Case-insensitive comparison that tolerates one leading prefix letter on either side:
 * "S700000001" ↔ "700000001", "i300000001" ↔ "300000001".
 * `prefixes` limits which letters count: "s" for delivery notes, "i" for invoices.
 */
export function docNumsMatch(fileBase: string, docNumber: string, prefixes = 'si'): boolean {
  const f = fileBase.toLowerCase();
  const d = docNumber.toLowerCase().trim();
  if (!d) return false;
  if (f === d) return true;
  const strip = (x: string) => (x.length > 1 && prefixes.includes(x[0]) ? x.slice(1) : x);
  return strip(f) === d || f === strip(d);
}

export interface PdfMatchResult {
  /** Files that match an expected document, in the order given. */
  matched: { name: string; doc: string }[];
  /** Files that belong to none of the expected documents. */
  unmatched: string[];
  /** Expected documents with no file. */
  missing: string[];
}

export function matchPdfs(fileNames: string[], docNumbers: string[], prefixes = 'si'): PdfMatchResult {
  const docs = [...new Set(docNumbers.map((d) => d.trim()).filter(Boolean))];
  const matched: PdfMatchResult['matched'] = [];
  const unmatched: string[] = [];
  for (const name of fileNames) {
    const base = extractDocNum(name);
    const doc = docs.find((d) => docNumsMatch(base, d, prefixes));
    if (doc) matched.push({ name, doc });
    else unmatched.push(name);
  }
  const missing = docs.filter((d) => !fileNames.some((n) => docNumsMatch(extractDocNum(n), d, prefixes)));
  return { matched, unmatched, missing };
}

export function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}
