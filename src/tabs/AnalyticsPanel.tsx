import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { store } from '../data/store';
import type { AdminAnalytics, ExportKind } from '../data/types';
import {
  ACTION_LABEL,
  bucketize,
  daysSince,
  importFreshness,
  inPeriod,
  isActiveSince,
  KIND_LABEL,
  KINDS,
  lastAction,
  periodStart,
  PERIODS,
  relativeAge,
  totals,
  totalsByUser,
  type Bucket,
  type Period,
} from '../lib/analytics';
import { dateTimeDisplay, ils } from '../lib/format';

const STALE_OPTIONS = [1, 3, 7, 14];
const DUP_PREVIEW = 10;

export function AnalyticsPanel() {
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<Period>(30);
  const [staleDays, setStaleDays] = useState(3);
  const [showAllDups, setShowAllDups] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await store.adminRpc('admin_analytics')) as AdminAnalytics | null;
      // numeric columns can arrive as strings
      for (const b of d?.batches ?? []) {
        b.lines = Number(b.lines) || 0;
        b.value = Number(b.value) || 0;
      }
      setData(d);
      setError(d ? null : 'אין הרשאה לצפות בנתונים');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const now = useMemo(() => (data ? new Date(data.generated_at) : new Date()), [data]);
  const since = useMemo(() => periodStart(period, now), [period, now]);
  const periodBatches = useMemo(() => (data ? inPeriod(data.batches, since) : []), [data, since]);
  const sum = useMemo(() => totals(periodBatches), [periodBatches]);
  const byUser = useMemo(() => totalsByUser(periodBatches), [periodBatches]);
  const chart = useMemo(() => bucketize(data?.batches ?? [], period, now), [data, period, now]);

  if (error && !data) return <div className="alert alert-red">{error}</div>;
  if (!data) return <div className="small-gray">טוען נתונים…</div>;

  const registered = data.users.filter((u) => u.registered);
  const active = registered.filter((u) => isActiveSince(u, since));
  const users = [...data.users].sort((a, b) => {
    const ta = Math.max(...[a.last_sign_in_at, lastAction(a)?.at].map((x) => (x ? new Date(x).getTime() : 0)));
    const tb = Math.max(...[b.last_sign_in_at, lastAction(b)?.at].map((x) => (x ? new Date(x).getTime() : 0)));
    return tb - ta;
  });
  const lastImport = data.imports[0] ?? null;
  const fresh = importFreshness(lastImport?.created_at ?? null, now);
  const stale = data.open_drafts.filter((d) => daysSince(d.updated_at, now) >= staleDays);
  const staleByUser = new Map<string, number>();
  for (const d of stale) staleByUser.set(d.email ?? '–', (staleByUser.get(d.email ?? '–') ?? 0) + 1);
  const dups = showAllDups ? data.duplicate_docs : data.duplicate_docs.slice(0, DUP_PREVIEW);

  return (
    <div className="analytics" data-testid="analytics">
      <div className="an-toolbar">
        <div className="an-periods" role="group" aria-label="תקופה">
          {PERIODS.map((p) => (
            <button key={p} className={'an-chip' + (p === period ? ' on' : '')} aria-pressed={p === period} onClick={() => setPeriod(p)}>
              {p === 365 ? 'שנה' : `${p} ימים`}
            </button>
          ))}
        </div>
        <span className="small-gray">עודכן: {dateTimeDisplay(data.generated_at)}</span>
        <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'מרענן…' : '↻ רענן'}
        </button>
      </div>
      {error && <div className="alert alert-red">{error}</div>}

      {/* KPI row */}
      <div className="an-kpis">
        <Kpi label="משתמשים פעילים" value={`${active.length}`} sub={`מתוך ${registered.length} רשומים`} />
        <Kpi
          label="דיווחים"
          value={sum.reports.toLocaleString('he-IL')}
          sub={
            KINDS.filter((k) => sum.byKind[k])
              .map((k) => `${KIND_LABEL[k]}: ${sum.byKind[k]}`)
              .join(' · ') || 'אין דיווחים בתקופה'
          }
        />
        <Kpi label="שורות שדווחו" value={sum.lines.toLocaleString('he-IL')} />
        <Kpi label="שווי שדווח" value={ils(sum.value)} />
        <Kpi
          label="קובץ הזמנות פתוחות"
          value={lastImport ? relativeAge(lastImport.created_at, now) : 'לא הועלה'}
          sub={lastImport ? `הועלה ע״י ${lastImport.email ?? '–'}` : undefined}
          status={fresh}
        />
      </div>

      {/* Volume chart */}
      <div className="section">
        <div className="section-title">דיווחים לפי {chart.granularity === 'day' ? 'יום' : chart.granularity === 'week' ? 'שבוע' : 'חודש'}</div>
        <VolumeChart buckets={chart.buckets} />
      </div>

      {/* Users */}
      <div className="section">
        <div className="section-title">פעילות משתמשים</div>
        <div className="table-wrap">
          <table className="an-table" data-testid="analytics-users">
            <thead>
              <tr>
                <th>משתמש</th>
                <th>כניסה אחרונה</th>
                <th>פעולה אחרונה</th>
                <th>דיווחים בתקופה</th>
                <th>שורות</th>
                <th>שווי</th>
                <th>בחירות פתוחות</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const act = lastAction(u);
                const t = byUser.get(u.email.toLowerCase());
                return (
                  <tr key={u.email}>
                    <td>
                      <bdi dir="ltr">{u.email}</bdi>
                      {u.role === 'admin' && (
                        <span className="badge kind" style={{ marginRight: 6 }}>
                          מנהל
                        </span>
                      )}
                      {u.display_name && <div className="small-gray">{u.display_name}</div>}
                    </td>
                    {u.registered ? (
                      <>
                        <td title={u.last_sign_in_at ? dateTimeDisplay(u.last_sign_in_at) : undefined}>{relativeAge(u.last_sign_in_at, now)}</td>
                        <td title={act ? dateTimeDisplay(act.at) : undefined}>
                          {act ? (
                            <>
                              {ACTION_LABEL[act.kind]}
                              <div className="small-gray">{relativeAge(act.at, now)}</div>
                            </>
                          ) : (
                            '–'
                          )}
                        </td>
                      </>
                    ) : (
                      <td colSpan={2}>
                        <span className="badge kind">טרם נרשם</span>
                      </td>
                    )}
                    <td className="num">{t?.reports ?? 0}</td>
                    <td className="num">{(t?.lines ?? 0).toLocaleString('he-IL')}</td>
                    <td className="num">{ils(t?.value ?? 0)}</td>
                    <td className="num">{u.open_drafts || '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Open-orders file */}
      <div className="section">
        <div className="section-title">קובץ ההזמנות הפתוחות</div>
        {lastImport ? (
          <div className={'alert ' + (fresh === 'ok' ? 'alert-green' : fresh === 'warn' ? 'alert-amber' : 'alert-red')}>
            {fresh === 'ok' ? '✅ עדכני' : fresh === 'warn' ? '⚠ כדאי לעדכן' : '⛔ לא עודכן זמן רב'} — הקובץ האחרון הועלה{' '}
            {relativeAge(lastImport.created_at, now)} ({dateTimeDisplay(lastImport.created_at)}) על ידי <bdi dir="ltr">{lastImport.email ?? '–'}</bdi>
          </div>
        ) : (
          <div className="alert alert-red">⛔ עדיין לא הועלה קובץ הזמנות</div>
        )}
        {data.imports.length > 0 && (
          <div className="table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  <th>הועלה</th>
                  <th>על ידי</th>
                  <th>קובץ</th>
                  <th>הזמנות</th>
                  <th>שורות</th>
                </tr>
              </thead>
              <tbody>
                {data.imports.map((i, n) => (
                  <tr key={n}>
                    <td>{dateTimeDisplay(i.created_at)}</td>
                    <td>
                      <bdi dir="ltr">{i.email ?? '–'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{i.file_name}</bdi>
                    </td>
                    <td className="num">{i.pos}</td>
                    <td className="num">{i.rows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Duplicate delivery notes */}
      <div className="section">
        <div className="section-title">תעודות משלוח שדווחו יותר מפעם אחת ({data.duplicate_docs.length})</div>
        {data.duplicate_docs.length === 0 ? (
          <div className="small-gray">אין תעודות כפולות 👍</div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="an-table" data-testid="analytics-dups">
                <thead>
                  <tr>
                    <th>מס׳ תעודה</th>
                    <th>פעמים</th>
                    <th>דיווחים</th>
                  </tr>
                </thead>
                <tbody>
                  {dups.map((d) => (
                    <tr key={d.doc_number}>
                      <td>
                        <bdi dir="ltr">{d.doc_number}</bdi>
                      </td>
                      <td className="num">{d.reports.length}</td>
                      <td>
                        {d.reports.map((r, i) => (
                          <div key={i}>
                            {dateTimeDisplay(r.created_at)} · <bdi dir="ltr">{r.email ?? '–'}</bdi> · הזמנה <bdi dir="ltr">{r.pos.join(', ')}</bdi> (
                            {r.lines === 1 ? 'שורה אחת' : `${r.lines} שורות`})
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.duplicate_docs.length > DUP_PREVIEW && (
              <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setShowAllDups((v) => !v)}>
                {showAllDups ? 'הצג פחות' : `הצג את כל ${data.duplicate_docs.length}`}
              </button>
            )}
          </>
        )}
      </div>

      {/* Stuck work */}
      <div className="section">
        <div className="section-title an-title-row">
          <span>עבודה פתוחה שלא יוצאה ({stale.length})</span>
          <label className="small-gray">
            ללא שינוי לפחות{' '}
            <select value={staleDays} onChange={(e) => setStaleDays(Number(e.target.value))} aria-label="ימים ללא שינוי">
              {STALE_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? 'יום' : `${d} ימים`}
                </option>
              ))}
            </select>
          </label>
        </div>
        {stale.length === 0 ? (
          <div className="small-gray">אין בחירות פתוחות ישנות 👍</div>
        ) : (
          <>
            <div className="an-chips-row">
              {[...staleByUser].map(([email, n]) => (
                <span key={email} className="badge diff">
                  <bdi dir="ltr">{email}</bdi>: {n}
                </span>
              ))}
            </div>
            <div className="table-wrap">
              <table className="an-table" data-testid="analytics-stale">
                <thead>
                  <tr>
                    <th>משתמש</th>
                    <th>סוג</th>
                    <th>הזמנה</th>
                    <th>מס׳ תעודה / חשבונית</th>
                    <th>פריטים</th>
                    <th>עודכן לאחרונה</th>
                  </tr>
                </thead>
                <tbody>
                  {stale.map((d, i) => (
                    <tr key={i}>
                      <td>
                        <bdi dir="ltr">{d.email ?? '–'}</bdi>
                      </td>
                      <td>{KIND_LABEL[d.kind]}</td>
                      <td>
                        <bdi dir="ltr">{d.po}</bdi>
                      </td>
                      <td>{d.doc_number ? <bdi dir="ltr">{d.doc_number}</bdi> : <span className="small-gray">טרם הוזן</span>}</td>
                      <td className="num">{d.items}</td>
                      <td title={dateTimeDisplay(d.updated_at)}>{relativeAge(d.updated_at, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, status }: { label: string; value: string; sub?: string; status?: 'ok' | 'warn' | 'stale' }) {
  const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠' : status === 'stale' ? '⛔' : null;
  return (
    <div className={'an-kpi' + (status ? ` st-${status}` : '')}>
      <div className="an-kpi-label">{label}</div>
      <div className="an-kpi-value">
        {icon && <span aria-hidden="true">{icon} </span>}
        {value}
      </div>
      {sub && <div className="an-kpi-sub">{sub}</div>}
    </div>
  );
}

// ---------------- stacked column chart ----------------
const SERIES_VAR: Record<ExportKind, string> = {
  delivery: 'var(--series-1)',
  invoice_match: 'var(--series-2)',
  invoice_manual: 'var(--series-3)',
};
const H = 180;
const PAD = { top: 18, right: 8, bottom: 24, left: 30 };

function niceMax(n: number): number {
  if (n <= 4) return Math.max(n, 1);
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return n;
}

function VolumeChart({ buckets }: { buckets: Bucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const hasData = buckets.some((b) => b.total > 0);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(720);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBoxW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable, hasData]);
  const present = KINDS.filter((k) => buckets.some((b) => b.counts[k] > 0));
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.total)));
  const W = boxW;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / buckets.length;
  const barW = Math.min(24, Math.max(4, band * 0.6));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil((buckets.length * 44) / plotW));
  const showValues = band >= 22;

  if (!hasData) return <div className="small-gray">אין דיווחים בתקופה שנבחרה</div>;

  return (
    <div className="viz-root">
      <div className="an-legend">
        {present.map((k) => (
          <span key={k}>
            <i style={{ background: SERIES_VAR[k] }} />
            {KIND_LABEL[k]}
          </span>
        ))}
        <button className="btn btn-sm an-table-toggle" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'הצג גרף' : 'הצג כטבלה'}
        </button>
      </div>
      {asTable ? (
        <div className="table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th>תקופה</th>
                {present.map((k) => (
                  <th key={k}>{KIND_LABEL[k]}</th>
                ))}
                <th>סה״כ</th>
              </tr>
            </thead>
            <tbody>
              {buckets
                .filter((b) => b.total)
                .map((b) => (
                  <tr key={b.key}>
                    <td>{b.title}</td>
                    {present.map((k) => (
                      <td key={k} className="num">
                        {b.counts[k]}
                      </td>
                    ))}
                    <td className="num">{b.total}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="an-chart" dir="ltr" ref={boxRef} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="דיווחים לאורך זמן">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="an-grid" />
                <text x={PAD.left - 6} y={y(t) + 4} className="an-axis" textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            {buckets.map((b, i) => {
              const cx = PAD.left + band * i + band / 2;
              let top = y(0);
              const segs = present
                .filter((k) => b.counts[k] > 0)
                .map((k) => {
                  const h = (b.counts[k] / max) * plotH;
                  const seg = { k, y: top - h, h };
                  top -= h;
                  return seg;
                });
              return (
                <g key={b.key}>
                  {segs.map((s, j) => {
                    const isTop = j === segs.length - 1;
                    const gap = j > 0 ? 2 : 0; // surface gap between stacked segments
                    const h = Math.max(1, s.h - gap);
                    const r = isTop ? Math.min(4, h, barW / 2) : 0;
                    const x0 = cx - barW / 2;
                    const yTop = s.y;
                    const d = `M${x0},${yTop + h} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + barW - r} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} V${yTop + h} Z`;
                    return <path key={s.k} d={d} fill={SERIES_VAR[s.k]} opacity={hover === null || hover === i ? 1 : 0.45} />;
                  })}
                  {showValues && b.total > 0 && (
                    <text x={cx} y={y(b.total) - 5} className="an-value" textAnchor="middle">
                      {b.total}
                    </text>
                  )}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={H - 6} className="an-axis" textAnchor="middle">
                      {b.label}
                    </text>
                  )}
                  <rect
                    x={PAD.left + band * i}
                    y={PAD.top}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    data-testid={`bar-${b.key}`}
                  />
                </g>
              );
            })}
            <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="an-baseline" />
          </svg>
          {hover !== null && (
            <div
              className="an-tip"
              dir="rtl"
              style={{
                left: Math.min(Math.max(PAD.left + band * hover + band / 2, 80), W - 80),
                top: 4,
              }}
              role="tooltip"
            >
              <b>{buckets[hover].title}</b>
              {present.map((k) => (
                <div key={k}>
                  <i style={{ background: SERIES_VAR[k] }} />
                  {KIND_LABEL[k]}: {buckets[hover].counts[k]}
                </div>
              ))}
              <div className="an-tip-total">סה״כ: {buckets[hover].total}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
