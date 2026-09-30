import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { FolderDrop } from '../components/FolderDrop';
import { store } from '../data/store';
import { byName, csvBlob, saveBlob } from '../lib/files';
import { dateTimeDisplay, fileStamp, ils } from '../lib/format';
import {
  buildHistoryIndex,
  buildMatchExport,
  errorsCsvFull,
  errorsCsvPackage,
  exportableLines,
  findInvoicePdf,
  invPdfName,
  lineKey,
  MIN_LINE_PRICE,
  parseInvoiceReport,
  parsePortalDN,
  resolveLines,
  runMatch,
  SheetFormatError,
  zeroQtyLines,
  exportedGross,
  linesMatchInvoice,
  withLines,
  type HistEntry,
  type InvoiceRow,
  type LineOverride,
  type MatchRow,
  type PortalDN,
} from '../lib/invoiceMatch';
import { readSheet } from '../lib/readSheet';
import { buildZipBlob, type ZipEntry } from '../lib/zip';

const BADGE: Record<MatchRow['status'], string> = { ok: 'תקין', diff: 'סכום שונה', missing: 'לא נמצא' };

export function MatchTab() {
  const [portal, setPortal] = useState<Map<string, PortalDN> | null>(null);
  const [portalMsg, setPortalMsg] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [invMsg, setInvMsg] = useState<string | null>(null);
  const [vat, setVat] = useState('18');
  const [tol, setTol] = useState('1');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allocEdit, setAllocEdit] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, LineOverride>>({});
  const [openDetail, setOpenDetail] = useState<Set<string>>(new Set());
  const [pdfs, setPdfs] = useState<Map<string, File>>(new Map());
  const [history, setHistory] = useState<Map<string, HistEntry>>(new Map());
  const [histState, setHistState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [prevInv, setPrevInv] = useState<Map<string, string>>(new Map());
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);

  const result = useMemo(
    () => (portal && invoices ? runMatch(portal, invoices, parseFloat(vat), parseFloat(tol)) : null),
    [portal, invoices, vat, tol],
  );
  const rows = result?.rows ?? [];

  // Default selection: all "ok" invoices once per pair of loaded files. Later recalculations
  // (VAT / tolerance) keep the user's choice and only drop invoices that stopped being ok.
  const defaultedFor = useRef<[unknown, unknown] | null>(null);
  useEffect(() => {
    if (!result) return;
    const fresh = !defaultedFor.current || defaultedFor.current[0] !== portal || defaultedFor.current[1] !== invoices;
    defaultedFor.current = [portal, invoices];
    const okNow = new Set(result.rows.filter((r) => r.status === 'ok').map((r) => r.invNo));
    setSelected((prev) => {
      if (fresh) return okNow;
      return new Set([...prev].filter((k) => okNow.has(k)));
    });
  }, [result, portal, invoices]);

  // Order-line numbers reported earlier through the delivery tab, and invoices already exported.
  useEffect(() => {
    if (!invoices) return;
    let active = true;
    setHistState('loading');
    const dns = [...new Set(invoices.map((i) => i.dn).filter(Boolean))];
    const invs = [...new Set(invoices.map((i) => i.invNo))];
    Promise.all([store.deliveryHistoryForDocs(dns), store.invoiceHistoryFor(invs)])
      .then(([lines, prev]) => {
        if (!active) return;
        setHistory(buildHistoryIndex(lines));
        const m = new Map<string, string>();
        for (const p of prev) if (!m.has(p.inv_no)) m.set(p.inv_no, p.created_at);
        setPrevInv(m);
        setHistState('ready');
      })
      .catch(() => active && setHistState('error'));
    return () => {
      active = false;
    };
  }, [invoices]);

  async function loadFile(file: File | undefined, which: 'portal' | 'inv') {
    if (!file) return;
    try {
      const sheet = await readSheet(file);
      // Manual line numbers are tied to line positions — they don't survive a new file.
      setOverrides({});
      setOpenDetail(new Set());
      if (which === 'portal') {
        const map = parsePortalDN(sheet);
        setPortal(map);
        setPortalMsg(`✓ ${file.name} — ${map.size} תעודות משלוח`);
      } else {
        const list = parseInvoiceReport(sheet);
        setAllocEdit({});
        setInvoices(list);
        setInvMsg(`✓ ${file.name} — ${list.length} חשבוניות`);
      }
    } catch (e) {
      alert(e instanceof SheetFormatError ? e.message : 'שגיאה בקריאת הקובץ: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  const counts = { ok: 0, diff: 0, missing: 0 };
  for (const r of rows) counts[r.status]++;
  const bad = rows.filter((r) => r.status !== 'ok');
  const okAll = rows.filter((r) => r.status === 'ok');
  const willExport = okAll.filter((r) => selected.has(r.invNo));
  const tolNum = Math.abs(parseFloat(tol) || 0);

  const exportStats = useMemo(() => {
    let dropped = 0,
      noLine = 0,
      rounded = 0,
      zeroQty = 0;
    const mismatch: MatchRow[] = [];
    const badAlloc: string[] = [];
    for (const r of willExport) {
      dropped += r.lines.filter((l) => l.price < MIN_LINE_PRICE).length;
      noLine += resolveLines(r, history, overrides).filter((x) => x.req && !x.line).length;
      if (Math.abs(r.diff ?? 0) > 0.005) rounded++;
      zeroQty += zeroQtyLines(r).length;
      if (exportableLines(r).length && !linesMatchInvoice(r, parseFloat(vat), parseFloat(tol))) mismatch.push(r);
      const alloc = allocEdit[r.invNo] !== undefined ? allocEdit[r.invNo] : r.alloc;
      if (/[,"\r\n]/.test(alloc)) badAlloc.push(r.invNo);
    }
    return { dropped, noLine, rounded, zeroQty, mismatch, badAlloc };
  }, [willExport, history, overrides, vat, tol, allocEdit]);
  const prevSelected = willExport.filter((r) => prevInv.has(r.invNo));

  function toggleSel(inv: string, on: boolean) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (on) n.add(inv);
      else n.delete(inv);
      return n;
    });
  }

  function selectAllOk(on: boolean) {
    setSelected(on ? new Set(okAll.map((r) => r.invNo)) : new Set());
  }

  function setLine(r: MatchRow, idx: number, val: string) {
    const k = lineKey(r.key, idx);
    setOverrides((prev) => ({ ...prev, [k]: { ...prev[k], line: val.trim() } }));
  }

  function downloadErrors() {
    if (!bad.length) return alert('אין שגויים');
    saveBlob(csvBlob(errorsCsvFull(rows, allocEdit)), `שגויים_${fileStamp()}.csv`);
  }

  async function doExport(mode: 'csv' | 'zip') {
    if (!result) return;
    const ex = buildMatchExport(rows, selected, allocEdit, history, overrides, result.siteCodeByName);
    if (ex.blocked.length) {
      alert(
        ex.blocked.length +
          ' חשבוניות שסומנו אינן תקינות ולכן לא ייכללו בקובץ:\n\n' +
          ex.blocked
            .slice(0, 12)
            .map((r) => r.invNo + ' — ' + (r.status === 'missing' ? 'לא נמצאה בפורטל' : 'הפרש בסכום'))
            .join('\n') +
          (ex.blocked.length > 12 ? '\n… ועוד ' + (ex.blocked.length - 12) : ''),
      );
    }
    if (!ex.exported.length) return alert('אין חשבוניות תקינות לייצוא');
    if (ex.emptied.length) {
      alert(
        ex.emptied.length +
          ' חשבוניות לא ייכללו בקובץ — כל שורותיהן במחיר נמוך מ-₪1:\n\n' +
          ex.emptied
            .slice(0, 10)
            .map((r) => r.invNo + ' (ת.משלוח ' + r.dn + ')')
            .join('\n'),
      );
    }
    if (!ex.lines.length) return alert('אין שורות לייצוא');
    if (exportStats.badAlloc.length) return alert('מספר הקצאה מכיל פסיק או מירכאות — יש לתקן:\n' + exportStats.badAlloc.join('\n'));

    const warnings: string[] = [];
    if (exportStats.mismatch.length)
      warnings.push(
        'חשבוניות שסכום השורות בקובץ (כמות × מחיר + מע"מ) אינו תואם את סכום החשבונית:\n' +
          exportStats.mismatch.map((r) => `  ${r.invNo}: בקובץ ${ils(exportedGross(r, parseFloat(vat)))} · בחשבונית ${ils(r.amount)}`).join('\n'),
      );
    if (exportStats.noLine) warnings.push(`${exportStats.noLine} שורות חייבות מספר שורת הזמנה ועדיין חסר להן — פתחו את החשבונית (▸) והשלימו.`);
    if (exportStats.zeroQty) warnings.push(`${exportStats.zeroQty} שורות עם "כמות שהתקבלה" 0 ייכתבו לקובץ בכמות 0.`);
    const prevEx = ex.exported.filter((r) => prevInv.has(r.invNo));
    if (prevEx.length)
      warnings.push('חשבוניות שכבר יוצאו בעבר:\n' + prevEx.map((r) => `  ${r.invNo} — ${dateTimeDisplay(prevInv.get(r.invNo)!)}`).join('\n'));
    if (warnings.length && !confirm(warnings.join('\n\n') + '\n\nלהמשיך בכל זאת?')) return;

    setBusy(true);
    try {
      const stamp = fileStamp();
      const folder = `${stamp}_חשבוניות`;
      const csv = '﻿' + ex.csv;
      const names = pdfs.size ? [...pdfs.keys()] : [];
      const attachments: { target: string; file: File }[] = [];
      if (mode === 'zip') {
        const seen = new Set<string>();
        for (const r of withLines(ex)) {
          const f = findInvoicePdf(names, r.invNo);
          const target = invPdfName(r.invNo);
          if (f && !seen.has(target)) {
            seen.add(target);
            attachments.push({ target, file: pdfs.get(f)! });
          }
        }
      }
      try {
        await store.recordExport({
          kind: 'invoice_match',
          file_name: mode === 'zip' ? `${folder}.zip` : `${stamp}_חשבוניות.csv`,
          csv,
          total: ex.exported.reduce((s, r) => s + r.amount, 0),
          pdf_names: attachments.map((a) => a.target),
          meta: {
            invoices: withLines(ex).map((r) => r.invNo),
            vat: parseFloat(vat) || 0,
            tolerance: tolNum,
            ok: counts.ok,
            diff: counts.diff,
            missing: counts.missing,
          },
          invoice_lines: ex.lines,
        });
        const m = new Map(prevInv);
        const now = new Date().toISOString();
        for (const r of ex.exported) if (!m.has(r.invNo)) m.set(r.invNo, now);
        setPrevInv(m);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!confirm(`שמירת הייצוא בהיסטוריה נכשלה:\n${msg}\n\nלהוריד את הקובץ בכל זאת?`)) return;
      }
      if (mode === 'csv') {
        saveBlob(csvBlob(csv), `${stamp}_חשבוניות.csv`);
        return;
      }
      const files: ZipEntry[] = [{ name: `${folder}/${stamp}.csv`, data: csv }];
      if (bad.length) files.push({ name: `${folder}/שגויים_${stamp}.csv`, data: errorsCsvPackage(rows) });
      for (const a of attachments) files.push({ name: `${folder}/${a.target}`, data: new Uint8Array(await a.file.arrayBuffer()) });
      saveBlob(buildZipBlob(files), `${folder}.zip`);
      setHint(`נוצרה חבילה: ${withLines(ex).length} חשבוניות, ${attachments.length} קבצי PDF${bad.length ? `, קובץ שגויים עם ${bad.length} רשומות` : ''}.`);
    } catch (e) {
      alert('שגיאה בבניית החבילה: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  const selectedOk = rows.filter((r) => r.status === 'ok' && selected.has(r.invNo));
  const pdfNames = [...pdfs.keys()];

  return (
    <div className="scroll-page">
      <div className="page-narrow">
        {/* STEP 1 */}
        <div className="section">
          <div className="section-title">1 · טעינת שני הקבצים</div>
          <div className="grid-2">
            <div>
              <label className="upload-label">
                <span>⬆ תעודות משלוח מפורטל הלקוח</span>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  data-testid="portal-input"
                  onChange={(e) => {
                    void loadFile(e.target.files?.[0], 'portal');
                    e.target.value = '';
                  }}
                />
              </label>
              <div className="small-gray" style={{ marginTop: 5, color: portalMsg ? 'var(--green)' : undefined, fontWeight: portalMsg ? 600 : 400 }}>
                {portalMsg ?? 'לא נטען'}
              </div>
            </div>
            <div>
              <label className="upload-label purple">
                <span>⬆ דוח חשבוניות מהתוכנה שלנו</span>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  data-testid="invoice-report-input"
                  onChange={(e) => {
                    void loadFile(e.target.files?.[0], 'inv');
                    e.target.value = '';
                  }}
                />
              </label>
              <div className="small-gray" style={{ marginTop: 5, color: invMsg ? '#6d28d9' : undefined, fontWeight: invMsg ? 600 : 400 }}>
                {invMsg ?? 'לא נטען'}
              </div>
            </div>
          </div>
          <div className="params">
            <span style={{ fontWeight: 600 }}>מע"מ להוספה לסכום הפורטל:</span>
            <input type="number" value={vat} min={0} max={100} step={0.1} onChange={(e) => setVat(e.target.value)} aria-label='מע"מ' />
            <span>%</span>
            <span className="small-gray">הפורטל מציג סכום לפני מע"מ; הדוח שלנו כולל מע"מ.</span>
            <span className="small-gray" style={{ marginRight: 'auto' }}>
              הפרש עיגול מותר:
            </span>
            <input type="number" value={tol} min={0} step={0.5} onChange={(e) => setTol(e.target.value)} aria-label="הפרש עיגול מותר" style={{ width: 60 }} />
            <span className="small-gray">₪</span>
          </div>
        </div>

        {result && (
          <>
            <div className="grid-3">
              <div className="stat ok">
                <div className="v" data-testid="cnt-ok">{counts.ok}</div>
                <div className="l">תקינות — נמצאו והסכום תואם</div>
              </div>
              <div className="stat diff">
                <div className="v" data-testid="cnt-diff">{counts.diff}</div>
                <div className="l">נמצאו אך הסכום שונה</div>
              </div>
              <div className="stat miss">
                <div className="v" data-testid="cnt-missing">{counts.missing}</div>
                <div className="l">לא נמצאו בפורטל</div>
              </div>
            </div>

            {bad.length > 0 && (
              <div className="section">
                <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>קובץ שגויים</span>
                  <button className="btn btn-sm btn-danger" onClick={downloadErrors}>
                    ⬇ הורד קובץ שגויים
                  </button>
                </div>
                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {bad.map((r) => (
                    <div key={r.key} style={{ display: 'flex', gap: 10, padding: '5px 8px', borderBottom: '1px solid #f5f5f5', fontSize: 11, alignItems: 'center' }}>
                      <span style={{ color: r.status === 'missing' ? 'var(--red)' : 'var(--amber)', fontWeight: 700, width: 70, flexShrink: 0 }}>
                        {r.status === 'missing' ? 'לא נמצא' : 'סכום'}
                      </span>
                      <span style={{ fontWeight: 600, width: 80, flexShrink: 0 }}>{r.invNo}</span>
                      <span style={{ fontFamily: 'monospace', width: 90, flexShrink: 0 }}>{r.dn}</span>
                      <span style={{ color: '#666', flex: 1 }}>
                        {r.status === 'missing'
                          ? 'תעודת המשלוח אינה קיימת בדוח הפורטל'
                          : `שלנו ${ils(r.amount)} · פורטל+מע"מ ${ils(r.portalGross)} · הפרש ${ils(r.diff)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* STEP 2 */}
            <div className="section">
              <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>2 · חשבוניות לדיווח</span>
                <span className="small-gray">
                  {!selectedOk.length ? (
                    <span style={{ color: 'var(--red)' }}>לא נבחרו חשבוניות תקינות</span>
                  ) : (
                    <>
                      {selectedOk.length} מתוך {okAll.length} חשבוניות תקינות · {ils(selectedOk.reduce((s, r) => s + r.amount, 0))}
                      {okAll.length - selectedOk.length > 0 && (
                        <span style={{ color: 'var(--amber)' }}> · {okAll.length - selectedOk.length} תקינות לא סומנו — לחצו "סמן תקינות"</span>
                      )}
                    </>
                  )}
                </span>
                <div className="btn-row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" onClick={() => selectAllOk(true)}>
                    סמן תקינות
                  </button>
                  <button className="btn btn-sm" onClick={() => selectAllOk(false)}>
                    נקה
                  </button>
                </div>
              </div>
              <div className="scroll-box sticky-head">
                <table data-testid="match-table">
                  <thead>
                    <tr>
                      <th>✓</th>
                      <th>חשבונית</th>
                      <th>מספר הקצאה</th>
                      <th>ת. משלוח</th>
                      <th>אתר</th>
                      <th className="center">תאריך</th>
                      <th className="num-left">סכום שלנו</th>
                      <th className="num-left">פורטל + מע"מ</th>
                      <th className="num-left">הפרש</th>
                      <th className="center">מצב</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const alloc = allocEdit[r.invNo] !== undefined ? allocEdit[r.invNo] : r.alloc;
                      const isOpen = openDetail.has(r.key);
                      return (
                        <Fragment key={r.key}>
                          <tr style={{ background: r.status === 'missing' ? '#fffafa' : undefined }}>
                            <td className="center">
                              <input
                                type="checkbox"
                                className="chk"
                                checked={selected.has(r.invNo) && r.status === 'ok'}
                                disabled={r.status !== 'ok'}
                                title={r.status === 'missing' ? 'תעודה שלא נמצאה בפורטל אינה ניתנת לדיווח' : r.status === 'diff' ? 'חשבונית עם הפרש בסכום אינה ניתנת לדיווח' : ''}
                                onChange={(e) => toggleSel(r.invNo, e.target.checked)}
                                aria-label={`בחר חשבונית ${r.invNo}`}
                              />
                            </td>
                            <td style={{ fontWeight: 600 }}>
                              {r.status === 'ok' ? (
                                <button
                                  className="expander"
                                  title="הצג שורות ומספרי שורת הזמנה"
                                  onClick={() =>
                                    setOpenDetail((prev) => {
                                      const n = new Set(prev);
                                      if (n.has(r.key)) n.delete(r.key);
                                      else n.add(r.key);
                                      return n;
                                    })
                                  }
                                >
                                  {isOpen ? '▾' : '▸'} {r.invNo}
                                </button>
                              ) : (
                                r.invNo
                              )}
                              {prevInv.has(r.invNo) && (
                                <span className="badge diff" style={{ marginRight: 6 }} title={`יוצאה ב-${dateTimeDisplay(prevInv.get(r.invNo)!)}`}>
                                  יוצאה בעבר
                                </span>
                              )}
                            </td>
                            <td>
                              <input
                                className={'small-input' + (alloc ? '' : ' warn')}
                                style={{ width: 105 }}
                                value={alloc}
                                placeholder="—"
                                onChange={(e) => setAllocEdit((p) => ({ ...p, [r.invNo]: e.target.value.trim() }))}
                                aria-label={`מספר הקצאה לחשבונית ${r.invNo}`}
                              />
                            </td>
                            <td style={{ fontFamily: 'monospace' }}>{r.dn}</td>
                            <td style={{ fontSize: 11 }}>
                              {r.site || '—'}
                              {r.status !== 'missing' && portal?.get(r.dn)?.status && !portal.get(r.dn)!.status.includes('מאושר') && (
                                <span className="badge diff" style={{ marginRight: 4 }} title="סטטוס תעודת המשלוח בפורטל">
                                  {portal.get(r.dn)!.status}
                                </span>
                              )}
                            </td>
                            <td className="center" style={{ fontSize: 11 }}>
                              {r.date}
                            </td>
                            <td className="num-left">{ils(r.amount)}</td>
                            <td className="num-left" style={{ color: '#666' }}>
                              {r.portalGross === null ? '—' : ils(r.portalGross)}
                            </td>
                            <td
                              className="num-left"
                              style={{ fontWeight: 600, color: r.diff === null ? '#999' : r.status === 'ok' ? 'var(--green)' : 'var(--red)' }}
                            >
                              {r.diff === null ? '—' : ils(Math.abs(r.diff) < 0.005 ? 0 : r.diff)}
                            </td>
                            <td className="center">
                              <span className={'badge ' + r.status}>{BADGE[r.status]}</span>
                            </td>
                          </tr>
                          {r.status === 'ok' && isOpen && (
                            <tr>
                              <td colSpan={10} className="detail-cell">
                                <MatchDetail r={r} history={history} overrides={overrides} onLine={(idx, val) => setLine(r, idx, val)} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* STEP 3 */}
            <div className="section">
              <div className="section-title">3 · צירוף קבצי PDF של החשבוניות</div>
              <FolderDrop
                testId="match-pdf-input"
                title="גרור תיקייה לכאן"
                subtitle="הקבצים מותאמים אוטומטית לפי מספר החשבונית"
                onFiles={(files) => setPdfs(byName(files))}
              />
              {pdfs.size > 0 && (
                <div className="pdf-list">
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#444', marginBottom: 6 }}>📄 {pdfs.size} קבצי PDF נטענו:</div>
                  {selectedOk.map((r) => {
                    const f = findInvoicePdf(pdfNames, r.invNo);
                    const target = invPdfName(r.invNo);
                    return f ? (
                      <div className="pdf-match-item" key={r.key}>
                        <span className="pdf-ok">✓</span>
                        <span>{f}</span>
                        <span className="small-gray">
                          → {target}
                          {f !== target && <span style={{ color: 'var(--amber)' }}> (שם הקובץ ישונה)</span>}
                        </span>
                      </div>
                    ) : (
                      <div className="pdf-match-item" key={r.key}>
                        <span className="pdf-no">✗</span>
                        <span style={{ color: 'var(--red)' }}>{r.invNo} — לא נמצא קובץ PDF</span>
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 6, fontSize: 11, color: '#555' }}>
                    <strong>{selectedOk.filter((r) => findInvoicePdf(pdfNames, r.invNo)).length}</strong> מתוך <strong>{selectedOk.length}</strong> חשבוניות נבחרות אותרו
                  </div>
                </div>
              )}
            </div>

            {/* STEP 4 */}
            <div className="section">
              <div className="section-title">4 · הורדת החבילה</div>
              <div className={'alert ' + (willExport.length ? 'alert-green' : 'alert-red')} data-testid="export-summary">
                <b>ייכללו בקובץ ה-CSV: {willExport.length} חשבוניות תקינות בלבד.</b>
                {exportStats.dropped > 0 && (
                  <>
                    <br />
                    {exportStats.dropped} שורות פריט יורדו מהקובץ — מחיר יחידה נמוך מ-₪{MIN_LINE_PRICE} (הפורטל אינו קולט שורות 0).
                  </>
                )}
                {exportStats.noLine > 0 && (
                  <>
                    <br />
                    <span style={{ color: 'var(--red)' }}>
                      ⚠ {exportStats.noLine} שורות חייבות מספר שורת הזמנה (אותו מק"ט במחירים שונים) — פתח את החשבונית (▸) והשלם.
                    </span>
                  </>
                )}
                {exportStats.zeroQty > 0 && (
                  <>
                    <br />
                    <span style={{ color: 'var(--amber)' }}>
                      ⚠ {exportStats.zeroQty} שורות מופיעות בפורטל עם "כמות שהתקבלה" 0 אך עם סכום — הן ייכתבו לקובץ בכמות 0. מומלץ לבדוק.
                    </span>
                  </>
                )}
                {exportStats.mismatch.length > 0 && (
                  <>
                    <br />
                    <span style={{ color: 'var(--amber)' }}>
                      ⚠ ב-{exportStats.mismatch.length} חשבוניות סכום השורות שייכתבו לקובץ אינו תואם את סכום החשבונית: {exportStats.mismatch.map((r) => r.invNo).join(', ')}.
                    </span>
                  </>
                )}
                {exportStats.badAlloc.length > 0 && (
                  <>
                    <br />
                    <span style={{ color: 'var(--red)' }}>⚠ מספר הקצאה מכיל פסיק או מירכאות: {exportStats.badAlloc.join(', ')}</span>
                  </>
                )}
                {exportStats.rounded > 0 && (
                  <>
                    <br />
                    מתוכן {exportStats.rounded} בהפרש עיגול של עד ₪{tolNum} מול תעודת המשלוח.
                  </>
                )}
                {bad.length > 0 && (
                  <>
                    <br />
                    <span style={{ color: 'var(--red)' }}>
                      {bad.length} חשבוניות לא ייכללו ויופיעו בקובץ השגויים ({counts.missing} לא נמצאו, {counts.diff} הפרש בסכום).
                    </span>
                  </>
                )}
                {okAll.length - willExport.length > 0 && (
                  <>
                    <br />
                    <span style={{ color: 'var(--amber)' }}>{okAll.length - willExport.length} חשבוניות תקינות אינן מסומנות ולכן לא ייכללו.</span>
                  </>
                )}
                {prevSelected.length > 0 && (
                  <>
                    <br />
                    <span style={{ color: 'var(--amber)' }}>⚠ {prevSelected.length} מהחשבוניות המסומנות כבר יוצאו בעבר ({prevSelected.map((r) => r.invNo).join(', ')}).</span>
                  </>
                )}
                {histState === 'error' && (
                  <>
                    <br />
                    <span style={{ color: 'var(--red)' }}>⚠ טעינת היסטוריית הדיווחים נכשלה — מספרי שורה לא יושלמו אוטומטית.</span>
                  </>
                )}
                {histState === 'loading' && (
                  <>
                    <br />
                    טוען היסטוריית דיווחים…
                  </>
                )}
              </div>
              <div className="btn-row">
                <button className="btn btn-export" disabled={busy} onClick={() => void doExport('zip')}>
                  ⬇ הורד חבילה (CSV + PDF)
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={() => void doExport('csv')}>
                  ⬇ CSV בלבד
                </button>
                <span className="small-gray">{hint}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MatchDetail({
  r,
  history,
  overrides,
  onLine,
}: {
  r: MatchRow;
  history: Map<string, HistEntry>;
  overrides: Record<string, LineOverride>;
  onLine: (idx: number, val: string) => void;
}) {
  const res = resolveLines(r, history, overrides);
  const missing = res.filter((x) => x.req && !x.line).length;
  const zero = zeroQtyLines(r).length;
  return (
    <div>
      <div style={{ fontSize: 11, color: missing ? 'var(--red)' : 'var(--green)', margin: '6px 0', fontWeight: 600 }}>
        {missing ? `⚠ ${missing} שורות חייבות מספר שורת הזמנה — אותו מק"ט מופיע במחירים שונים` : '✓ אין בחשבונית זו שורות שדורשות מספר שורת הזמנה'}
      </div>
      {zero > 0 && (
        <div style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 6, fontWeight: 600 }}>
          ⚠ {zero} שורות עם "כמות שהתקבלה" 0 בפורטל אך עם סכום
        </div>
      )}
      <table style={{ border: '1px solid #e5e5e5' }}>
        <thead>
          <tr>
            <th>מק"ט</th>
            <th className="center">כמות</th>
            <th className="num-left">מחיר</th>
            <th>מספר הזמנה</th>
            <th className="center">שורת הזמנה</th>
            <th>מקור</th>
          </tr>
        </thead>
        <tbody>
          {res.map(({ l, po, line, src, req }, idx) => {
            const bad = req && !line;
            return (
              <tr key={idx} style={{ background: bad ? '#fffafa' : '#fafbff' }}>
                <td className="sku">{l.sku}</td>
                <td className="center" style={{ color: l.qty === 0 ? 'var(--amber)' : undefined, fontWeight: l.qty === 0 ? 700 : undefined }}>
                  {l.qty}
                </td>
                <td className="num-left">{ils(l.price)}</td>
                <td>{po || <span style={{ color: 'var(--red)' }}>חסר</span>}</td>
                <td className="center">
                  <input
                    className={'small-input' + (bad ? ' bad' : '')}
                    style={{ width: 60, textAlign: 'center' }}
                    value={line}
                    placeholder="—"
                    onChange={(e) => onLine(idx, e.target.value)}
                    aria-label={`שורת הזמנה עבור ${l.sku}`}
                  />
                </td>
                <td className="small-gray">{src}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {exportableLines(r).length < r.lines.length && (
        <div className="small-gray" style={{ marginTop: 4 }}>
          {r.lines.length - exportableLines(r).length} שורות במחיר נמוך מ-₪{MIN_LINE_PRICE} אינן מוצגות ואינן נכתבות לקובץ.
        </div>
      )}
    </div>
  );
}
