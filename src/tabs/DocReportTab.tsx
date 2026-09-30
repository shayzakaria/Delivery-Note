import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderDrop } from '../components/FolderDrop';
import { store } from '../data/store';
import type { DocLineRecord } from '../data/types';
import { buildDocCsv, DOC_KINDS, docExportNames, selectionTotal, validateSelections, type DocKind, type DocSelection } from '../lib/docExport';
import { isEmptyDraft, reconcileDrafts, type DraftState } from '../lib/drafts';
import { byName, csvBlob, saveBlob } from '../lib/files';
import { dateTimeDisplay, ils, isoToDisplay, parseQty, qtyDisplay, todayISO } from '../lib/format';
import { distinct, matchesQuery, type PoGroup, type PoLine } from '../lib/openOrders';
import { matchPdfs } from '../lib/pdfMatch';
import { buildZipBlob, type ZipEntry } from '../lib/zip';
import { useOpenOrders } from '../state/OpenOrders';

type View = 'items' | 'export';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const emptyDraft = (): DraftState => ({ docNumber: '', docDate: todayISO(), items: {} });

export function DocReportTab({ kind }: { kind: DocKind }) {
  const cfg = DOC_KINDS[kind];
  const isDelivery = kind === 'delivery';
  const oo = useOpenOrders();
  const groups = oo.groups;
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.po, g])), [groups]);

  // ---------------- drafts (persisted per user) ----------------
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const dirty = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const retry = useRef<number | undefined>(undefined);
  const flushRef = useRef<() => Promise<void>>(async () => {});

  const flush = useCallback(async () => {
    const pos = [...dirty.current];
    dirty.current.clear();
    if (!pos.length) return;
    setSaveState('saving');
    try {
      const toDelete: string[] = [];
      for (const po of pos) {
        const d = draftsRef.current[po];
        if (isEmptyDraft(d)) toDelete.push(po);
        else await store.saveDraft({ kind, po, doc_number: d.docNumber, doc_date: d.docDate || null, items: d.items });
      }
      if (toDelete.length) await store.deleteDrafts(kind, toDelete);
      setSaveState('saved');
    } catch {
      pos.forEach((p) => dirty.current.add(p));
      setSaveState('error');
      window.clearTimeout(retry.current);
      retry.current = window.setTimeout(() => {
        chain.current = chain.current.then(() => flushRef.current());
      }, 5000);
    }
  }, [kind]);
  flushRef.current = flush;

  const scheduleSave = useCallback(
    (delay = 700) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        chain.current = chain.current.then(flush);
      }, delay);
    },
    [flush],
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && dirty.current.size) {
        window.clearTimeout(timer.current);
        chain.current = chain.current.then(flush);
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [flush]);

  useEffect(() => {
    let active = true;
    store
      .loadDrafts(kind)
      .then((rows) => {
        if (!active) return;
        const map: Record<string, DraftState> = {};
        for (const r of rows) {
          const items: DraftState['items'] = {};
          for (const [k, v] of Object.entries(r.items || {})) if (v && typeof v === 'object') items[k] = { q: String(v.q ?? ''), s: String(v.s ?? '') };
          map[r.po] = { docNumber: r.doc_number || '', docDate: r.doc_date || todayISO(), items };
        }
        setDrafts(map);
        setDraftsLoaded(true);
      })
      .catch((e) => active && setDraftError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, [kind]);

  // Drop selections that are no longer open whenever drafts or the open-orders data change.
  useEffect(() => {
    if (!draftsLoaded || oo.loading) return;
    const { next, dropped, changed } = reconcileDrafts(draftsRef.current, groupMap);
    if (!changed.length) return;
    setDrafts(next);
    changed.forEach((p) => dirty.current.add(p));
    scheduleSave(50);
    if (dropped) setNotice(`${dropped} פריטים שסומנו בעבר הוסרו מהבחירה — הם כבר אינם פתוחים בקובץ ההזמנות העדכני.`);
  }, [draftsLoaded, oo.loading, groupMap, scheduleSave]);

  const updateDraft = useCallback(
    (po: string, fn: (d: DraftState) => DraftState) => {
      setDrafts((prev) => ({ ...prev, [po]: fn(prev[po] ?? emptyDraft()) }));
      dirty.current.add(po);
      scheduleSave();
    },
    [scheduleSave],
  );

  // ---------------- selection & filters ----------------
  const [activePO, setActivePO] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [site, setSite] = useState('');
  const [buyer, setBuyer] = useState('');
  const [view, setView] = useState<View>('items');
  const docInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activePO && !groupMap.has(activePO)) {
      setActivePO(null);
      setView('items');
    }
  }, [activePO, groupMap]);

  const sites = useMemo(() => distinct(oo.lines.map((l) => l.site_name)), [oo.lines]);
  const buyers = useMemo(() => distinct(oo.lines.map((l) => l.buyer)), [oo.lines]);
  const filtered = useMemo(
    () => groups.filter((g) => (!site || g.site_name === site) && (!buyer || g.buyer === buyer) && matchesQuery(g, query)),
    [groups, site, buyer, query],
  );

  const selections: DocSelection[] = useMemo(() => {
    const out: DocSelection[] = [];
    for (const g of groups) {
      const d = drafts[g.po];
      if (!d) continue;
      const items: DocSelection['items'] = [];
      for (const l of g.lines) {
        const it = d.items[String(l.line_no)];
        if (it) items.push({ line: l, qty: parseQty(it.q) });
      }
      if (items.length) out.push({ po: g.po, docNumber: d.docNumber, docDate: d.docDate, items });
    }
    return out;
  }, [groups, drafts]);
  const totalItems = selections.reduce((s, x) => s + x.items.length, 0);

  function openPO(po: string) {
    if (activePO && activePO !== po) {
      const cur = drafts[activePO];
      if (cur && Object.keys(cur.items).length > 0 && !cur.docNumber.trim()) {
        alert(`יש למלא ${cfg.docLabel} להזמנה ${activePO} לפני המעבר להזמנה הבאה.`);
        docInputRef.current?.focus();
        return;
      }
    }
    setActivePO(po);
    setView('items');
  }

  function toggleItem(po: string, l: PoLine, on: boolean) {
    updateDraft(po, (d) => {
      const items = { ...d.items };
      if (on) items[String(l.line_no)] = { q: String(l.balance), s: l.sku };
      else delete items[String(l.line_no)];
      return { ...d, items };
    });
  }

  function setQty(po: string, l: PoLine, q: string) {
    updateDraft(po, (d) => ({ ...d, items: { ...d.items, [String(l.line_no)]: { q, s: l.sku } } }));
  }

  function selectAll(g: PoGroup) {
    updateDraft(g.po, (d) => {
      const all = g.lines.every((l) => d.items[String(l.line_no)] !== undefined);
      if (all) return { ...d, items: {} };
      const items: DraftState['items'] = { ...d.items };
      for (const l of g.lines) items[String(l.line_no)] ??= { q: String(l.balance), s: l.sku };
      return { ...d, items };
    });
  }

  function clearAll(ask = true) {
    if (ask && !confirm('לנקות את כל הבחירות?')) return;
    const next: Record<string, DraftState> = {};
    for (const [po, d] of Object.entries(draftsRef.current)) {
      next[po] = { ...d, docNumber: '', items: {} };
      dirty.current.add(po);
    }
    setDrafts(next);
    scheduleSave(50);
    setActivePO(null);
    setView('items');
    setLastExport(null);
  }

  // ---------------- PDFs ----------------
  const [pdfs, setPdfs] = useState<Map<string, File>>(new Map());
  const docNumbers = useMemo(() => selections.map((s) => s.docNumber.trim()).filter(Boolean), [selections]);
  const pdfResult = useMemo(() => matchPdfs([...pdfs.keys()], docNumbers, cfg.pdfPrefix.toLowerCase()), [pdfs, docNumbers, cfg.pdfPrefix]);

  // ---------------- previously reported (delivery only) ----------------
  const [reported, setReported] = useState<Map<string, { at: string; batch: string }>>(new Map());
  const sessionBatches = useRef(new Set<string>());
  const docKey = docNumbers.join(',');
  useEffect(() => {
    if (!isDelivery || view !== 'export' || !docNumbers.length) {
      setReported(new Map());
      return;
    }
    let active = true;
    const t = window.setTimeout(() => {
      store
        .deliveryHistoryForDocs(docNumbers)
        .then((rows) => {
          if (!active) return;
          const m = new Map<string, { at: string; batch: string }>();
          for (const r of rows) if (!sessionBatches.current.has(r.batch_id) && !m.has(r.doc_number)) m.set(r.doc_number, { at: r.created_at, batch: r.batch_id });
          setReported(m);
        })
        .catch(() => active && setReported(new Map()));
    }, 400);
    return () => {
      active = false;
      window.clearTimeout(t);
    };
  }, [isDelivery, view, docKey]);

  // ---------------- export ----------------
  const [busy, setBusy] = useState(false);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const recorded = useRef(new Map<string, string>());

  async function doExport(mode: 'zip' | 'csv') {
    if (!selections.length) return alert('לא נבחרו פריטים');
    const v = validateSelections(selections);
    if (v.missingDoc.length) return alert(`הזמנות ללא ${cfg.docLabel}:\n` + v.missingDoc.join('\n'));
    if (v.unsafeDoc.length) return alert(`${cfg.docLabel} מכיל פסיק, מירכאות או שבירת שורה — יש לתקן:\n` + v.unsafeDoc.join('\n'));
    if (v.badSite.length) return alert('הזמנות ללא קוד אתר תקין בקובץ ההזמנות:\n' + v.badSite.join('\n'));
    if (v.missingDate.length) return alert('הזמנות ללא תאריך:\n' + v.missingDate.join('\n'));
    if (v.invalidQty.length) return alert('כמות לא תקינה (חייבת להיות גדולה מ-0):\n' + v.invalidQty.map((x) => `${x.po} — שורה ${x.line_no}`).join('\n'));

    const warnings: string[] = [];
    if (v.overBalance.length)
      warnings.push('כמות גדולה מהכמות הפתוחה:\n' + v.overBalance.map((x) => `  ${x.po} — שורה ${x.line_no}: ${x.qty} (פתוח ${x.balance})`).join('\n'));
    if (v.nonNumericDoc.length) warnings.push(`${cfg.docLabel} שאינו מספר:\n  ` + v.nonNumericDoc.join(', '));
    let prev = new Map<string, string>();
    if (isDelivery) {
      try {
        const rows = await store.deliveryHistoryForDocs(docNumbers);
        for (const r of rows) if (!sessionBatches.current.has(r.batch_id) && !prev.has(r.doc_number)) prev.set(r.doc_number, r.created_at);
      } catch {
        prev = new Map();
      }
      if (prev.size) warnings.push('תעודות שכבר דווחו בעבר:\n' + [...prev].map(([d, at]) => `  ${d} — ${dateTimeDisplay(at)}`).join('\n'));
    }
    if (mode === 'zip') {
      if (!pdfs.size) warnings.push('לא נבחרה תיקיית PDF — החבילה תכיל את קובץ ה-CSV בלבד.');
      else if (pdfResult.missing.length) warnings.push('לא נמצא קובץ PDF עבור:\n  ' + pdfResult.missing.join(', '));
    }
    if (warnings.length && !confirm(warnings.join('\n\n') + '\n\nלהמשיך בכל זאת?')) return;

    setBusy(true);
    try {
      const csv = buildDocCsv(selections);
      const names = docExportNames(kind);
      const matched = pdfResult.matched.map((m) => m.name);
      if (!recorded.current.has(csv)) {
        const docLines: DocLineRecord[] = selections.flatMap((s) =>
          s.items.map((it) => ({
            doc_number: s.docNumber.trim(),
            doc_date: s.docDate,
            site_code: it.line.site_code,
            po: s.po,
            line_no: it.line.line_no,
            sku: it.line.sku,
            item_desc: it.line.item_desc,
            qty: it.qty,
            price: it.line.price,
          })),
        );
        try {
          const id = await store.recordExport({
            kind,
            file_name: mode === 'zip' ? names.zipName : names.csvName,
            csv,
            total: selectionTotal(selections),
            pdf_names: mode === 'zip' ? matched : [],
            meta: { orders: selections.length, docs: [...new Set(docNumbers)] },
            doc_lines: docLines,
          });
          recorded.current.set(csv, id);
          sessionBatches.current.add(id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!confirm(`שמירת הדיווח בהיסטוריה נכשלה:\n${msg}\n\nלהוריד את הקובץ בכל זאת?`)) return;
        }
      }
      if (mode === 'csv') saveBlob(csvBlob(csv), names.csvName);
      else {
        const files: ZipEntry[] = [{ name: names.csvPathInZip, data: csv }];
        for (const name of distinct(matched)) {
          const f = pdfs.get(name);
          if (f) files.push({ name: `${names.folder}/${name}`, data: new Uint8Array(await f.arrayBuffer()) });
        }
        saveBlob(buildZipBlob(files), names.zipName);
      }
      setLastExport(
        `${mode === 'zip' ? 'החבילה הורדה' : 'קובץ ה-CSV הורד'} (${selections.length} הזמנות, ${totalItems} פריטים` +
          (mode === 'zip' ? `, ${distinct(matched).length} קבצי PDF` : '') +
          ')' +
          (recorded.current.has(csv) ? ' והדיווח נשמר בהיסטוריה.' : '.'),
      );
    } catch (e) {
      alert('שגיאה בבניית החבילה: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(file: File | undefined) {
    if (!file) return;
    if (oo.info && !confirm('טעינת קובץ חדש תחליף את רשימת ההזמנות הפתוחות עבור כל המשתמשים. להמשיך?')) return;
    try {
      await oo.importFile(file);
      setNotice(null);
    } catch (e) {
      alert('שגיאה בקריאת הקובץ: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ---------------- render ----------------
  const active = activePO ? groupMap.get(activePO) : undefined;
  const activeDraft = activePO ? (drafts[activePO] ?? emptyDraft()) : null;
  const issues = validateSelections(selections);
  const total = selectionTotal(selections);

  return (
    <div className="layout">
      {/* LEFT */}
      <aside className="left-panel">
        <div className="panel-header">
          <h3>{isDelivery ? 'הזמנות פתוחות' : 'הזמנות לחשבונית'}</h3>
          {isDelivery ? (
            <div style={{ marginBottom: 2 }}>
              <div className={'file-status' + (oo.info ? '' : ' warn')}>
                {oo.loading
                  ? 'טוען נתונים…'
                  : oo.info
                    ? `✓ ${oo.info.file_name} | ${oo.info.po_count} הזמנות פתוחות | עודכן ${
                        oo.info.file_modified_at ? isoToDisplay(oo.info.file_modified_at.slice(0, 10)) : '–'
                      }`
                    : '↑ טען קובץ הזמנות פתוחות מהפורטל כדי להתחיל'}
              </div>
              <label className={'upload-label' + (oo.importing ? ' busy' : '')}>
                <span>{oo.importing ? '⏳ טוען את הקובץ…' : '⬆ טען קובץ Excel מעודכן מהפורטל'}</span>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  data-testid="open-orders-input"
                  onChange={(e) => {
                    void onUpload(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              {oo.info && (
                <div className="saved-bar">
                  <span>
                    💾 נשמר במערכת · {oo.info.row_count} שורות · {oo.info.created_by_email || ''} · {dateTimeDisplay(oo.info.created_at)}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="alert alert-blue" style={{ marginBottom: 0 }}>
              <i>נתוני ההזמנות נטענים מאותו קובץ Excel של לשונית תעודות המשלוח — בחרו הזמנות לחשבונית</i>
            </div>
          )}
          {oo.error && <div className="alert alert-red" style={{ marginTop: 8 }}>{oo.error}</div>}
          <input
            className="search-input"
            placeholder={isDelivery ? "חפש לפי מס' PO / תיאור / ספרות..." : 'חפש הזמנה...'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="חיפוש הזמנה"
          />
          <div className="filter-row">
            <select value={site} onChange={(e) => setSite(e.target.value)} aria-label="סינון לפי אתר">
              <option value="">כל האתרים</option>
              {sites.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {isDelivery && (
              <select value={buyer} onChange={(e) => setBuyer(e.target.value)} aria-label="סינון לפי רוכש">
                <option value="">כל הרוכשים</option>
                {buyers.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="po-count-bar">
          <span>{oo.loading ? 'טוען...' : `${filtered.length} הזמנות`}</span>
          <span style={{ color: 'var(--green)', fontWeight: 600 }}>{selections.length > 0 ? `${selections.length} נבחרו` : ''}</span>
          <SaveIndicator state={saveState} />
        </div>
        <div className="po-list" data-testid="po-list">
          {!oo.loading && !filtered.length && <div className="no-results">לא נמצאו</div>}
          {filtered.map((g) => {
            const d = drafts[g.po];
            const selCount = d ? Object.keys(d.items).length : 0;
            const hasDoc = !!d?.docNumber.trim();
            const isActive = g.po === activePO;
            const balance = g.lines.reduce((s, l) => s + l.balance, 0);
            return (
              <button
                key={g.po}
                className={'po-item' + (isActive ? ' active-po' : '') + (selCount > 0 && !isActive ? ' has-doc' : '')}
                onClick={() => openPO(g.po)}
              >
                <div className="po-item-num">{g.po}</div>
                {selCount > 0 && <span className="sel-count">{selCount}</span>}
                <div className="po-item-desc">{g.po_desc || '–'}</div>
                {isDelivery ? (
                  <>
                    <div className="po-item-meta">
                      📍 {g.site_name} | 👤 {g.buyer} | 📅 {isoToDisplay(g.order_date)}
                    </div>
                    <div className="po-item-meta">
                      כמות למשלוח: {qtyDisplay(balance)} יח' | {g.lines.length} פריטים
                    </div>
                  </>
                ) : (
                  <div className="po-item-meta">
                    📍 {g.site_name} | {g.lines.length} פריטים
                  </div>
                )}
                {selCount > 0 && (
                  <div className={'po-doc-tag' + (hasDoc ? '' : ' empty')}>
                    {hasDoc ? `📄 ${cfg.docLabelShort}: ${d!.docNumber}` : `⚠ ${cfg.missingDocLabel}`}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      {/* RIGHT */}
      <section className="right-panel">
        <div className="right-top">
          <div className="right-top-title">{active ? `${active.po} — ${active.po_desc}` : 'בחר הזמנה מהרשימה'}</div>
          <div className="btn-row" style={{ gap: 8 }}>
            {totalItems > 0 && (
              <>
                <span style={{ fontSize: 12, color: '#555' }}>
                  {selections.length} הזמנות | {totalItems} פריטים
                </span>
                <button className="btn btn-sm btn-primary" onClick={() => setView('export')}>
                  סיכום ויצוא ←
                </button>
              </>
            )}
          </div>
        </div>

        <div className="right-content">
          {draftError && <div className="alert alert-red">טעינת הבחירות השמורות נכשלה: {draftError}</div>}
          {notice && (
            <div className="alert alert-amber">
              {notice}{' '}
              <button className="linklike" onClick={() => setNotice(null)}>
                סגור
              </button>
            </div>
          )}
          {(active || view === 'export') && (
            <div className="tab-bar">
              <button className={'tab' + (view === 'items' ? ' active' : '')} onClick={() => setView('items')}>
                פריטים
              </button>
              <button className={'tab' + (view === 'export' ? ' active' : '')} onClick={() => setView('export')}>
                סיכום ויצוא
              </button>
            </div>
          )}

          {view === 'items' &&
            (!active || !activeDraft ? (
              <div className="empty-right">
                <div className="big">{isDelivery ? '📋' : '🧾'}</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{isDelivery ? 'בחר הזמנה מהרשימה' : 'בחר הזמנה לחשבונית'}</div>
                <div style={{ fontSize: 12 }}>
                  {isDelivery ? `ניתן לבחור מספר הזמנות — לכל הזמנה ${cfg.docLabelShort} משלה` : 'אותו מבנה CSV — קידומת i לקבצי PDF'}
                </div>
              </div>
            ) : (
              <div>
                <div className="doc-bar">
                  <label htmlFor={`doc-${kind}`}>{isDelivery ? '📄' : '🧾'} {cfg.docLabel}:</label>
                  <input
                    id={`doc-${kind}`}
                    ref={docInputRef}
                    className={'doc-input' + (activeDraft.docNumber ? ' filled' : '')}
                    placeholder={isDelivery ? 'הקלד מספר תעודה...' : 'הקלד מספר חשבונית...'}
                    value={activeDraft.docNumber}
                    onChange={(e) => updateDraft(active.po, (d) => ({ ...d, docNumber: e.target.value }))}
                  />
                  <label className="plain" htmlFor={`date-${kind}`}>
                    תאריך:
                  </label>
                  <input
                    id={`date-${kind}`}
                    type="date"
                    className="date-input"
                    value={activeDraft.docDate}
                    onChange={(e) => updateDraft(active.po, (d) => ({ ...d, docDate: e.target.value }))}
                  />
                  {activeDraft.docNumber.trim() && <span className="doc-status">✓ שמור</span>}
                  {activeDraft.docNumber.trim() && !/^\d+$/.test(activeDraft.docNumber.trim().replace(/^[sSiI]/, '')) && (
                    <span className="doc-warn">⚠ המספר אמור להכיל ספרות בלבד</span>
                  )}
                </div>
                <div className="items-card">
                  <div className="items-card-header">
                    <span>
                      פריטים להזמנה {active.po} ({active.lines.length})
                    </span>
                    <button className="btn btn-sm" onClick={() => selectAll(active)}>
                      סמן הכל
                    </button>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>✓</th>
                          <th title="מספר השורה בהזמנה בקובץ האקסל — נשלח לפורטל בעמודה I">שורה</th>
                          <th>מק"ט</th>
                          <th>תיאור פריט</th>
                          <th>כמות למשלוח</th>
                          <th>{cfg.qtyColumnLabel}</th>
                          <th className="num-left">מחיר יחידה</th>
                          <th className="num-left">סה"כ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {active.lines.map((l) => {
                          const it = activeDraft.items[String(l.line_no)];
                          const qty = it ? parseQty(it.q) : NaN;
                          const invalid = !!it && !(qty > 0);
                          const over = !!it && qty > l.balance + 1e-9;
                          return (
                            <tr key={l.line_no}>
                              <td>
                                <input
                                  type="checkbox"
                                  className="chk"
                                  checked={!!it}
                                  onChange={(e) => toggleItem(active.po, l, e.target.checked)}
                                  aria-label={`בחר שורה ${l.line_no}`}
                                />
                              </td>
                              <td className="line-no">{l.line_no}</td>
                              <td className="sku">{l.sku}</td>
                              <td style={{ maxWidth: 260, wordBreak: 'break-word' }}>{l.item_desc}</td>
                              <td className="bal">{qtyDisplay(l.balance)}</td>
                              <td>
                                <input
                                  className={'qty-input' + (invalid ? ' invalid' : over ? ' over' : '')}
                                  inputMode="decimal"
                                  disabled={!it}
                                  value={it ? it.q : ''}
                                  placeholder="0"
                                  title={invalid ? 'כמות לא תקינה' : over ? `גדול מהכמות הפתוחה (${l.balance})` : ''}
                                  onChange={(e) => setQty(active.po, l, e.target.value)}
                                  aria-label={`כמות לשורה ${l.line_no}`}
                                />
                              </td>
                              <td className="num-left">{ils(l.price)}</td>
                              <td className="total-cell">{it && qty > 0 ? ils(qty * l.price) : '–'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ))}

          {view === 'export' && (
            <div>
              <div className="section">
                <div className="section-title">סיכום לפני יצוא</div>
                {!selections.length ? (
                  <div className="alert alert-blue">לא נבחרו פריטים</div>
                ) : (
                  <>
                    {issues.missingDoc.length > 0 && (
                      <div className="alert alert-red">
                        ⚠ {issues.missingDoc.length} הזמנות ללא {cfg.docLabel}: {issues.missingDoc.join(', ')}
                      </div>
                    )}
                    {issues.missingDate.length > 0 && <div className="alert alert-red">⚠ הזמנות ללא תאריך: {issues.missingDate.join(', ')}</div>}
                    {issues.unsafeDoc.length > 0 && (
                      <div className="alert alert-red">⚠ {cfg.docLabel} מכיל תווים לא חוקיים (פסיק / מירכאות): {issues.unsafeDoc.join(', ')}</div>
                    )}
                    {issues.badSite.length > 0 && <div className="alert alert-red">⚠ הזמנות ללא קוד אתר תקין: {issues.badSite.join(', ')}</div>}
                    {issues.invalidQty.length > 0 && (
                      <div className="alert alert-red">⚠ כמות לא תקינה: {issues.invalidQty.map((x) => `${x.po} שורה ${x.line_no}`).join(', ')}</div>
                    )}
                    {issues.overBalance.length > 0 && (
                      <div className="alert alert-amber">
                        ⚠ כמות גדולה מהכמות הפתוחה: {issues.overBalance.map((x) => `${x.po} שורה ${x.line_no}`).join(', ')}
                      </div>
                    )}
                    {reported.size > 0 && (
                      <div className="alert alert-amber">
                        ⚠ תעודות שכבר דווחו בעבר: {[...reported].map(([d, r]) => `${d} (${dateTimeDisplay(r.at)})`).join(', ')}
                      </div>
                    )}
                    <div className="alert alert-green">
                      ✅ {selections.length} הזמנות | {totalItems} פריטים | סה"כ {ils(total)}
                    </div>
                    {selections.map((s) => {
                      const g = groupMap.get(s.po)!;
                      return (
                        <div className="summary-po-block" key={s.po}>
                          <div className="summary-po-title">
                            <span>
                              {s.po} — {g.po_desc}
                            </span>
                            <span className={s.docNumber.trim() ? 'summary-po-doc' : 'missing-doc'}>
                              {s.docNumber.trim() ? `${cfg.docLabelShort}: ${s.docNumber.trim()}` : `⚠ ${cfg.missingDocLabel}`} | {isoToDisplay(s.docDate)}
                            </span>
                          </div>
                          <div className="bordered">
                            <table>
                              <thead>
                                <tr>
                                  <th title="עמודה I בקובץ ה-CSV">שורה</th>
                                  <th>מק"ט</th>
                                  <th>תיאור</th>
                                  <th>כמות</th>
                                  <th className="num-left">מחיר</th>
                                  <th className="num-left">סה"כ</th>
                                </tr>
                              </thead>
                              <tbody>
                                {s.items.map((it) => (
                                  <tr key={it.line.line_no}>
                                    <td className="line-no">{it.line.line_no}</td>
                                    <td className="sku">{it.line.sku}</td>
                                    <td>{it.line.item_desc}</td>
                                    <td className="center">{Number.isFinite(it.qty) ? qtyDisplay(it.qty) : '⚠'}</td>
                                    <td className="num-left">{ils(it.line.price)}</td>
                                    <td className="total-cell">{Number.isFinite(it.qty) ? ils(it.qty * it.line.price) : '–'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>

              <div className="section">
                <div className="section-title">📁 {isDelivery ? 'צירוף תעודות משלוח (PDF)' : 'צירוף חשבוניות (PDF) — קידומת i'}</div>
                <FolderDrop
                  testId={`pdf-input-${kind}`}
                  title="גרור תיקייה לכאן"
                  subtitle={isDelivery ? 'הממשק יאתר אוטומטית PDF לפי מספר תעודה' : 'הממשק מאתר אוטומטית i[מספר].pdf לפי מספר חשבונית'}
                  onFiles={(files) => setPdfs(byName(files))}
                />
                {pdfs.size > 0 && (
                  <div className="pdf-list" data-testid="pdf-list">
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#444', marginBottom: 6 }}>📄 {pdfs.size} קבצי PDF נטענו:</div>
                    {pdfResult.matched.map((m) => (
                      <div className="pdf-match-item" key={m.name}>
                        <span className="pdf-ok">✓</span>
                        <span>{m.name}</span>
                        <span className="small-gray">
                          → {cfg.docLabelShort} {m.doc}
                        </span>
                      </div>
                    ))}
                    {pdfResult.missing.map((d) => (
                      <div className="pdf-match-item" key={'miss-' + d}>
                        <span className="pdf-no">✗</span>
                        <span style={{ color: 'var(--red)' }}>
                          {cfg.pdfPrefix}
                          {d}.pdf — לא נמצא בתיקייה
                        </span>
                      </div>
                    ))}
                    {pdfResult.unmatched.map((n) => (
                      <div className="pdf-match-item" key={'x-' + n}>
                        <span className="pdf-extra">○</span>
                        <span className="muted">{n}</span>
                        <span className="small-gray muted">לא מזוהה</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 6, fontSize: 11, color: '#555' }}>
                      <strong>{pdfResult.matched.length}</strong> PDF מזוהים | <strong>{pdfResult.unmatched.length}</strong> לא מזוהים
                      {pdfResult.missing.length > 0 && (
                        <>
                          {' '}
                          | <strong style={{ color: 'var(--red)' }}>{pdfResult.missing.length}</strong> חסרים
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="section">
                {lastExport && (
                  <div className="alert alert-green">
                    ✓ {lastExport}{' '}
                    <button className="btn btn-sm" style={{ marginRight: 8 }} onClick={() => clearAll()}>
                      נקה בחירות לדיווח הבא
                    </button>
                  </div>
                )}
                <div className="btn-row">
                  <button className="btn btn-export" disabled={busy} onClick={() => doExport('zip')}>
                    ⬇ הורד חבילה (CSV + PDF)
                  </button>
                  <button className="btn btn-primary" disabled={busy} onClick={() => doExport('csv')}>
                    ⬇ CSV בלבד
                  </button>
                  <button className="btn" onClick={() => setView('items')}>
                    ← חזרה לפריטים
                  </button>
                  <button className="btn btn-danger push" onClick={() => clearAll()}>
                    ✕ נקה הכל
                  </button>
                </div>
                <div className="hint">
                  שם קובץ: {docExportNames(kind).csvName}
                  {docNumbers.length
                    ? ` | קבצי PDF: ${distinct(docNumbers).map((d) => cfg.pdfPrefix + d + '.pdf').join(', ')}`
                    : isDelivery
                      ? ' | יש להזין מספרי תעודה'
                      : ''}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saving') return <span title="שומר את הבחירות">שומר…</span>;
  if (state === 'saved') return <span title="הבחירות נשמרו — יישמרו גם אחרי רענון">💾 נשמר</span>;
  if (state === 'error') return <span style={{ color: 'var(--red)' }} title="השמירה נכשלה, ננסה שוב בשינוי הבא">⚠ לא נשמר</span>;
  return <span />;
}
