import { useEffect, useRef, useState } from 'react';
import { AuthGate } from './auth/AuthGate';
import { APP_VERSION } from './config';
import { store } from './data/store';
import type { Role, SessionUser } from './data/types';
import { OpenOrdersProvider } from './state/OpenOrders';
import { flushAllPending } from './state/pendingSaves';
import { AdminTab } from './tabs/AdminTab';
import { DocReportTab } from './tabs/DocReportTab';
import { HistoryTab } from './tabs/HistoryTab';
import { MatchTab } from './tabs/MatchTab';

type TabId = 'delivery' | 'history' | 'invoice' | 'match' | 'admin';

const TABS: { id: TabId; label: string; adminOnly?: boolean }[] = [
  { id: 'delivery', label: '📦 תעודות משלוח' },
  { id: 'history', label: '📋 היסטוריה' },
  { id: 'invoice', label: '🧾 חשבוניות' },
  { id: 'match', label: '⚖ התאמת חשבוניות' },
  { id: 'admin', label: '👥 משתמשים', adminOnly: true },
];

export function App() {
  // Keyed by user: another account signing in on the same tab always starts from a clean state.
  return <AuthGate>{(user, role) => <Shell key={user.id} user={user} role={role} />}</AuthGate>;
}

function Shell({ user, role }: { user: SessionUser; role: Role }) {
  const [tab, setTab] = useState<TabId>('delivery');
  const [menu, setMenu] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  async function signOut() {
    setMenu(false);
    await flushAllPending(); // write unsaved selections while the session is still valid
    await store.signOut();
  }

  const show = (id: TabId) => {
    setTab(id);
    if (id === 'history') setHistoryTick((t) => t + 1);
  };

  return (
    <OpenOrdersProvider>
      <nav className="topbar" aria-label="ניווט ראשי">
        <div className="brand">
          <img className="logo-header" src="/mody-logo-dark.png" alt="MODY" />
          <span className="brand-sub">דיווח לפורטל סולל בונה</span>
        </div>
        {TABS.filter((t) => !t.adminOnly || role === 'admin').map((t) => (
          <button key={t.id} className={'main-tab' + (tab === t.id ? ' active' : '')} onClick={() => show(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="topbar-end" ref={menuRef}>
          <span>גרסה {APP_VERSION}{store.mode === 'mock' ? ' · הדגמה' : ''}</span>
          <button className="user-btn" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>
            <span dir="ltr">{user.email}</span> ▾
          </button>
          {menu && (
            <div className="user-menu" role="menu">
              <div className="um-head">
                מחובר כ-<b dir="ltr">{user.email}</b>
                <br />
                הרשאה: {role === 'admin' ? 'מנהל' : 'משתמש'}
              </div>
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setPwOpen(true);
                }}
              >
                🔑 שינוי סיסמה
              </button>
              <button role="menuitem" onClick={() => void signOut()}>
                ⎋ התנתקות
              </button>
            </div>
          )}
        </div>
      </nav>
      <main className="main">
        {/* Tabs stay mounted so switching keeps their work, like the original app. */}
        <div className="tab-root" data-testid="tab-delivery" hidden={tab !== 'delivery'}>
          <DocReportTab kind="delivery" userId={user.id} />
        </div>
        <div className="tab-root" data-testid="tab-history" hidden={tab !== 'history'}>
          <HistoryTab refreshKey={historyTick} isAdmin={role === 'admin'} />
        </div>
        <div className="tab-root" data-testid="tab-invoice" hidden={tab !== 'invoice'}>
          <DocReportTab kind="invoice_manual" userId={user.id} />
        </div>
        <div className="tab-root" data-testid="tab-match" hidden={tab !== 'match'}>
          <MatchTab />
        </div>
        {role === 'admin' && (
          <div className="tab-root" data-testid="tab-admin" hidden={tab !== 'admin'}>
            <AdminTab currentEmail={user.email} />
          </div>
        )}
      </main>
      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}
    </OpenOrdersProvider>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (pw !== pw2) return setMsg({ ok: false, text: 'הסיסמאות אינן זהות' });
    if (pw.length < 8) return setMsg({ ok: false, text: 'יש לבחור סיסמה של 8 תווים לפחות' });
    setBusy(true);
    try {
      await store.updatePassword(pw);
      setMsg({ ok: true, text: 'הסיסמה עודכנה' });
      setPw('');
      setPw2('');
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="שינוי סיסמה">
        <h3>שינוי סיסמה</h3>
        <input type="password" placeholder="סיסמה חדשה" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <input type="password" placeholder="אימות סיסמה" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {msg && <div className={'alert ' + (msg.ok ? 'alert-green' : 'alert-red')}>{msg.text}</div>}
        <div className="btn-row">
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            שמור
          </button>
          <button className="btn" onClick={onClose}>
            סגור
          </button>
        </div>
      </div>
    </div>
  );
}
