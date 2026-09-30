import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { store } from '../data/store';
import type { ImportInfo } from '../data/types';
import { groupByPo, parseOpenOrders, type PoGroup, type PoLine } from '../lib/openOrders';
import { readSheet } from '../lib/readSheet';

interface OpenOrdersState {
  loading: boolean;
  importing: boolean;
  error: string | null;
  info: ImportInfo | null;
  lines: PoLine[];
  groups: PoGroup[];
  importFile: (file: File) => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<OpenOrdersState | null>(null);

export function OpenOrdersProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ImportInfo | null>(null);
  const [lines, setLines] = useState<PoLine[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const latest = await store.latestImport();
      setInfo(latest);
      setLines(latest ? await store.importLines(latest.id) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const importFile = useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        const parsed = parseOpenOrders(await readSheet(file));
        if (!parsed.length) throw new Error('לא נמצאו שורות תקינות בקובץ');
        await store.importOpenOrders(file.name, file.lastModified ? new Date(file.lastModified).toISOString() : null, parsed);
        await reload();
      } finally {
        setImporting(false);
      }
    },
    [reload],
  );

  const groups = useMemo(() => groupByPo(lines), [lines]);
  const value = useMemo(
    () => ({ loading, importing, error, info, lines, groups, importFile, reload }),
    [loading, importing, error, info, lines, groups, importFile, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOpenOrders(): OpenOrdersState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOpenOrders outside provider');
  return v;
}
