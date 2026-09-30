import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { store } from '../data/store';
import type { BatchSummary, DocLineRecord, ExportKind } from '../data/types';
import { csvBlob, saveBlob } from '../lib/files';
import { dateTimeDisplay, ils, isoToDisplay, qtyDisplay } from '../lib/format';
import type { InvoiceCsvLine } from '../lib/invoiceMatch';

const KIND_LABEL: Record<ExportKind, string> = {
  delivery: '📦 תעודות משלוח',
  invoice_manual: '🧾 חשבוניות',
  invoice_match: '⚖ התאמת חשבוניות',
};

const LIMIT = 300;

function docsOf(b: BatchSummary): string[] {
  const m = b.meta as { docs?: unknown; invoices?: unknown };
  const list = Array.isArray(m.docs) ? m.docs : Array.isArray(m.invoices) ? m.invoices : [];
  return list.map(String);
}

function csvNameOf(b: BatchSummary): string {
  if (/\.csv$/i.test(b.file_name)) return b.file_name;
  return b.file_name.replace(/_[^_/]*\.zip$/i, '.csv').replace(/\.zip$/i, '.csv');
}

export function HistoryTab({ refreshKey, isAdmin }: { refreshKey: number; isAdmin: boolean }) {
  const [rows, setRows] = useState<BatchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | ExportKind>('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; doc: DocLineRecord[]; inv: InvoiceCsvLine[] } | null>(null);
  const requested = useRef<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await store.listBatches(LIMIT));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function toggle(b: BatchSummary) {
    if (open === b.id) {
      setOpen(null);
      return;
    }
    setOpen(b.id);
    setDetail(null);
    requested.current = b.id;
    try {
      const [doc, inv] = await Promise.all([
        b.kind === 'invoice_match' ? Promise.resolve([]) : store.batchDocLines(b.id),
        b.kind === 'invoice_match' ? store.batchInvoiceLines(b.id) : Promise.resolve([]),
      ]);
      if (requested.current === b.id) setDetail({ id: b.id, doc, inv }); // ignore late answers for another row
    } catch (e) {
      if (requested.current !== b.id) return;
      alert(e instanceof Error ? e.message : String(e));
      setOpen(null);
    }
  }

  async function download(b: BatchSummary) {
    try {
      saveBlob(csvBlob(await store.batchCsv(b.id)), csvNameOf(b));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(b: BatchSummary) {
    if (!confirm(`למחוק את הדיווח מ-${dateTimeDisplay(b.created_at)}?\nהמחיקה סופית ותשפיע גם על השלמת מספרי שורה בהתאמת חשבוניות.`)) return;
    try {
      await store.deleteBatch(b.id);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  const q = search.trim();
  const shown = (rows ?? []).filter((b) => (kind === 'all' || b.kind === kind) && (!q || docsOf(b).some((d) => d.includes(q)) || (b.created_by_email ?? '').includes(q)));

  return (
    <div className="scroll-page">
      <div className="section page-narrow">
        <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="section-title" style={{ margin: 0 }}>
            היסטוריית דיווחים
          </div>
          <div className="form-row">
            <input placeholder="חיפוש מס' תעודה / חשבונית / משתמש" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
            <select value={kind} onChange={(e) => setKind(e.target.value as 'all' | ExportKind)} aria-label="סוג דיווח">
              <option value="all">כל הסוגים</option>
              <option value="delivery">תעודות משלוח</option>
              <option value="invoice_manual">חשבוניות</option>
              <option value="invoice_match">התאמת חשבוניות</option>
            </select>
            <button className="btn btn-sm" onClick={() => void load()}>
              ↻ רענון
            </button>
          </div>
        </div>
        {error && <div className="alert alert-red">{error}</div>}
        {rows === null && !error && <div className="muted">טוען…</div>}
        {rows !== null && !shown.length && (
          <div style={{ textAlign: 'center', padding: 40, color: '#aaa', fontSize: 14 }}>
            {rows.length ? 'אין דיווחים שתואמים לסינון.' : 'עדיין לא דווחו תעודות. לאחר ייצוא, הדיווחים יופיעו כאן.'}
          </div>
        )}
        {shown.length > 0 && (
          <div className="table-wrap">
            <table data-testid="history-table">
              <thead>
                <tr>
                  <th>תאריך דיווח</th>
                  <th>סוג</th>
                  <th>משתמש</th>
                  <th>מס׳ תעודה / חשבונית</th>
                  <th className="center">שורות</th>
                  <th className="num-left">סה״כ</th>
                  <th>פעולות</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => {
                  const docs = docsOf(b);
                  return (
                    <Fragment key={b.id}>
                      <tr>
                        <td style={{ whiteSpace: 'nowrap', color: '#555' }}>{dateTimeDisplay(b.created_at)}</td>
                        <td>
                          <span className="badge kind">{KIND_LABEL[b.kind]}</span>
                        </td>
                        <td dir="ltr" style={{ textAlign: 'right', fontSize: 11 }}>
                          {b.created_by_email}
                        </td>
                        <td style={{ fontWeight: 600, maxWidth: 360 }}>
                          {docs.slice(0, 8).join(', ')}
                          {docs.length > 8 ? ` … ועוד ${docs.length - 8}` : ''}
                        </td>
                        <td className="center">{b.line_count}</td>
                        <td className="total-cell">{ils(b.total_value)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-sm" onClick={() => void toggle(b)}>
                            {open === b.id ? '▾ סגור' : '▸ פרטים'}
                          </button>{' '}
                          <button className="btn btn-sm" onClick={() => void download(b)}>
                            ⬇ CSV
                          </button>{' '}
                          {isAdmin && (
                            <button className="btn btn-sm btn-danger" onClick={() => void remove(b)}>
                              מחק
                            </button>
                          )}
                        </td>
                      </tr>
                      {open === b.id && (
                        <tr>
                          <td colSpan={7} className="detail-cell">
                            {detail?.id !== b.id ? (
                              <div className="muted" style={{ padding: 8 }}>
                                טוען…
                              </div>
                            ) : (
                              <BatchDetail b={b} doc={detail.doc} inv={detail.inv} />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {rows && rows.length >= LIMIT && <div className="hint">מוצגים {LIMIT} הדיווחים האחרונים.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function BatchDetail({ b, doc, inv }: { b: BatchSummary; doc: DocLineRecord[]; inv: InvoiceCsvLine[] }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <div className="small-gray" style={{ marginBottom: 6 }}>
        קובץ: <bdi dir="ltr">{b.file_name}</bdi>
        {b.pdf_names.length ? ` · ${b.pdf_names.length} קבצי PDF: ${b.pdf_names.join(', ')}` : ''}
      </div>
      <div className="bordered" style={{ background: '#fff' }}>
        {b.kind === 'invoice_match' ? (
          <table>
            <thead>
              <tr>
                <th>חשבונית</th>
                <th>הקצאה</th>
                <th>תאריך</th>
                <th>ת. משלוח</th>
                <th>מק"ט</th>
                <th className="center">כמות</th>
                <th className="num-left">מחיר</th>
                <th>הזמנה</th>
                <th>שורה</th>
              </tr>
            </thead>
            <tbody>
              {inv.map((l, i) => (
                <tr key={i}>
                  <td>{l.inv_no}</td>
                  <td>{l.alloc}</td>
                  <td>{l.inv_date}</td>
                  <td>{l.dn}</td>
                  <td className="sku">{l.sku}</td>
                  <td className="center">{qtyDisplay(l.qty)}</td>
                  <td className="num-left">{ils(l.price)}</td>
                  <td>{l.po}</td>
                  <td>{l.line_no}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{b.kind === 'delivery' ? 'תעודה' : 'חשבונית'}</th>
                <th>תאריך</th>
                <th>הזמנה</th>
                <th>שורה</th>
                <th>מק"ט</th>
                <th>תיאור</th>
                <th className="center">כמות</th>
                <th className="num-left">מחיר</th>
                <th className="num-left">סה"כ</th>
              </tr>
            </thead>
            <tbody>
              {doc.map((l, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{l.doc_number}</td>
                  <td>{isoToDisplay(l.doc_date)}</td>
                  <td>{l.po}</td>
                  <td className="line-no">{l.line_no}</td>
                  <td className="sku">{l.sku}</td>
                  <td>{l.item_desc}</td>
                  <td className="center">{qtyDisplay(l.qty)}</td>
                  <td className="num-left">{ils(l.price)}</td>
                  <td className="total-cell">{ils(l.qty * l.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
