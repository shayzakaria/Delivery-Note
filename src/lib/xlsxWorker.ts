/// <reference lib="webworker" />
// Spreadsheet parsing runs here, isolated from the app: a malformed or hostile
// file can only affect this short-lived worker, which is terminated afterwards.
import { parseWorkbook } from './xlsxParse';

self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const result = parseWorkbook(e.data);
    self.postMessage({ ok: true, rows: result.rows, date1904: result.date1904 });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
