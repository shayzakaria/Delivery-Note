import type { SheetData } from './cells';

const TIMEOUT_MS = 60_000;

/** Parses the first sheet of a spreadsheet file in a dedicated worker. */
export function readSheet(file: File): Promise<SheetData> {
  return file.arrayBuffer().then(
    (buf) =>
      new Promise<SheetData>((resolve, reject) => {
        const worker = new Worker(new URL('./xlsxWorker.ts', import.meta.url), { type: 'module' });
        const timer = window.setTimeout(() => {
          worker.terminate();
          reject(new Error('קריאת הקובץ ארכה זמן רב מדי'));
        }, TIMEOUT_MS);
        worker.onmessage = (e: MessageEvent<{ ok: boolean; rows?: SheetData['rows']; date1904?: boolean; error?: string }>) => {
          window.clearTimeout(timer);
          worker.terminate();
          if (e.data.ok && e.data.rows) resolve({ rows: e.data.rows, date1904: Boolean(e.data.date1904) });
          else reject(new Error(e.data.error || 'שגיאה בקריאת הקובץ'));
        };
        worker.onerror = (e) => {
          window.clearTimeout(timer);
          worker.terminate();
          reject(new Error(e.message || 'שגיאה בקריאת הקובץ'));
        };
        worker.postMessage(buf, [buf]);
      }),
  );
}
