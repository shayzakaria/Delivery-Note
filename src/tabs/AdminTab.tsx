import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { store } from '../data/store';
import type { Member, Role } from '../data/types';
import { dateTimeDisplay } from '../lib/format';

export function AdminTab({ currentEmail }: { currentEmail: string }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers(await store.listMembers());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return alert('כתובת מייל לא תקינה');
    void run(async () => {
      await store.addMember(clean, role, name);
      setEmail('');
      setName('');
      setRole('user');
    });
  }

  return (
    <div className="scroll-page">
      <div className="page-narrow">
        <div className="section">
          <div className="section-title">👥 משתמשים מורשים</div>
          {error && <div className="alert alert-red">{error}</div>}
          <form className="form-row" onSubmit={add} style={{ marginBottom: 14 }}>
            <input type="email" placeholder="אימייל" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: 240 }} />
            <input placeholder="שם (לא חובה)" value={name} onChange={(e) => setName(e.target.value)} />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="הרשאה">
              <option value="user">משתמש</option>
              <option value="admin">מנהל</option>
            </select>
            <button className="btn btn-primary" disabled={busy}>
              + הוסף
            </button>
          </form>
          {members && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>אימייל</th>
                    <th>שם</th>
                    <th>הרשאה</th>
                    <th>נוסף</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.email}>
                      <td dir="ltr" style={{ textAlign: 'right' }}>
                        {m.email}
                        {m.email === currentEmail.toLowerCase() ? ' (את/ה)' : ''}
                      </td>
                      <td>{m.display_name || '–'}</td>
                      <td>
                        <select
                          value={m.role}
                          disabled={busy}
                          onChange={(e) => void run(() => store.setMemberRole(m.email, e.target.value as Role))}
                          aria-label={`הרשאה עבור ${m.email}`}
                        >
                          <option value="user">משתמש</option>
                          <option value="admin">מנהל</option>
                        </select>
                      </td>
                      <td className="small-gray">{dateTimeDisplay(m.created_at)}</td>
                      <td>
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => confirm(`להסיר את ${m.email} מהמשתמשים המורשים?`) && void run(() => store.removeMember(m.email))}
                        >
                          הסר
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="section">
          <div className="section-title">איך מוסיפים משתמש חדש</div>
          <ol className="steps">
            <li>
              ב-Supabase: <b>Authentication → Users → Add user → Create new user</b>. מזינים את המייל וסיסמה זמנית ומסמנים <b>Auto Confirm User</b>.
            </li>
            <li>כאן: מוסיפים את אותו מייל לרשימה למעלה ובוחרים הרשאה.</li>
            <li>המשתמש נכנס עם הסיסמה הזמנית ומחליף אותה בתפריט המשתמש ← "שינוי סיסמה".</li>
          </ol>
          <div className="hint">
            גישה ניתנת רק למי שמופיע ברשימה <u>וגם</u> בעל חשבון מאומת. הסרה מהרשימה חוסמת את הגישה מיד, גם אם החשבון עדיין קיים.
          </div>
        </div>
      </div>
    </div>
  );
}
