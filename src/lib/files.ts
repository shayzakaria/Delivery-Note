import { isPdfName } from './pdfMatch';

/** Triggers a browser download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function csvBlob(content: string): Blob {
  return new Blob([content], { type: 'text/csv;charset=utf-8' });
}

type Entry = FileSystemEntry;

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  // readEntries() returns results in batches (Chrome: 100 per call) — keep reading until empty.
  const reader = dir.createReader();
  const all: Entry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

async function walk(entry: Entry, out: File[]): Promise<void> {
  if (entry.isFile) {
    if (!isPdfName(entry.name)) return;
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push(file);
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) await walk(child, out);
  }
}

/** PDF files from a drag-and-drop of folders and/or files (folders are read recursively). */
export async function pdfsFromDrop(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const entries: Entry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f && isPdfName(f.name)) loose.push(f);
    }
  }
  for (const e of entries) await walk(e, out);
  return [...out, ...loose];
}

/** PDF files from an <input type="file" webkitdirectory> selection. */
export function pdfsFromInput(list: FileList | null): File[] {
  return list ? Array.from(list).filter((f) => isPdfName(f.name)) : [];
}

/** Keeps one file per name (the last one wins, as in the production app). */
export function byName(files: File[]): Map<string, File> {
  const m = new Map<string, File>();
  for (const f of files) m.set(f.name, f);
  return m;
}
