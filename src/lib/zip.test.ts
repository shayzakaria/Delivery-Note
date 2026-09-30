import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZipParts, concatBytes, crc32 } from './zip';

describe('zip writer', () => {
  it('computes standard CRC-32', () => {
    const data = new TextEncoder().encode('שלום, MODY 123');
    expect(crc32(data)).toBe(nodeCrc32(data));
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('produces an archive that an independent implementation (Python zipfile) accepts', () => {
    const pdf = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    const bytes = concatBytes(
      buildZipParts(
        [
          { name: '23-08-2026_משלוחים/23-08-2026.csv', data: '﻿10000074,700000001,01/08/26,5000000001,,1,40,PO202600000101,15' },
          { name: '23-08-2026_משלוחים/S700000001.pdf', data: pdf },
          { name: '23-08-2026_משלוחים/S700000003.pdf', data: pdf.buffer },
        ],
        new Date(2026, 7, 23, 7, 2, 10),
      ),
    );
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const file = join(dir, 'a.zip');
    writeFileSync(file, bytes);
    const script = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(json.dumps({"bad": bad, "names": z.namelist(),
  "sizes": [i.file_size for i in z.infolist()],
  "utf8": [bool(i.flag_bits & 0x800) for i in z.infolist()],
  "dt": list(z.infolist()[0].date_time),
  "csv": z.read(z.namelist()[0]).decode("utf-8")}))`;
    const out = JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }));
    expect(out.bad).toBeNull();
    expect(out.names).toEqual(['23-08-2026_משלוחים/23-08-2026.csv', '23-08-2026_משלוחים/S700000001.pdf', '23-08-2026_משלוחים/S700000003.pdf']);
    expect(out.sizes[1]).toBe(70_000);
    expect(out.utf8).toEqual([true, true, true]);
    expect(out.dt).toEqual([2026, 8, 23, 7, 2, 10]);
    expect(out.csv).toBe('﻿10000074,700000001,01/08/26,5000000001,,1,40,PO202600000101,15');
  });
});
