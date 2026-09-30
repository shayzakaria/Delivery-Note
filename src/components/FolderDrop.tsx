import { useRef, useState, type InputHTMLAttributes } from 'react';
import { pdfsFromDrop, pdfsFromInput } from '../lib/files';

// Non-standard attributes that let the file picker select a whole folder.
const DIRECTORY_ATTRS = { webkitdirectory: '', directory: '' } as unknown as InputHTMLAttributes<HTMLInputElement>;

export function FolderDrop({ onFiles, title, subtitle, testId }: { onFiles: (files: File[]) => void; title: string; subtitle: string; testId?: string }) {
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={'drop-zone' + (over ? ' over' : '')}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          setReading(true);
          pdfsFromDrop(e.dataTransfer)
            .then(onFiles)
            .catch((err) => alert('שגיאה בקריאת התיקייה: ' + (err instanceof Error ? err.message : String(err))))
            .finally(() => setReading(false));
        }}
      >
        <div className="icon">📂</div>
        <strong>{reading ? 'קורא קבצים…' : title}</strong> או לחץ לבחירת תיקייה
        <br />
        <small>{subtitle}</small>
      </button>
      <input
        ref={input}
        data-testid={testId}
        type="file"
        multiple
        hidden
        {...DIRECTORY_ATTRS}
        onChange={(e) => {
          onFiles(pdfsFromInput(e.target.files));
          e.target.value = '';
        }}
      />
    </>
  );
}
