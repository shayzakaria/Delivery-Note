import { useState, type FormEvent } from 'react';
import { store } from '../data/store';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'login') await store.signIn(email, password);
      else {
        await store.sendPasswordReset(email);
        setMsg({ ok: true, text: 'אם הכתובת רשומה במערכת, נשלח אליה קישור לאיפוס סיסמה.' });
      }
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark">MODY</div>
        <h1>{mode === 'login' ? 'דיווח משלוחים · סולל בונה' : 'איפוס סיסמה'}</h1>
        {store.mode === 'mock' && <div className="msg ok">מצב הדגמה — ניתן להתחבר עם demo@mody.co.il וכל סיסמה.</div>}
        <label htmlFor="email">אימייל</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode === 'login' && (
          <>
            <label htmlFor="password">סיסמה</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}
        <button className="cta" type="submit" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'כניסה' : 'שלח קישור לאיפוס'}
        </button>
        {msg && <div className={'msg ' + (msg.ok ? 'ok' : 'err')}>{msg.text}</div>}
        <button
          type="button"
          className="alt"
          onClick={() => {
            setMode(mode === 'login' ? 'reset' : 'login');
            setMsg(null);
          }}
        >
          {mode === 'login' ? 'שכחתי סיסמה' : 'חזרה לכניסה'}
        </button>
      </form>
    </div>
  );
}

export function SetNewPassword({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return setErr('הסיסמאות אינן זהות');
    if (pw.length < 8) return setErr('יש לבחור סיסמה של 8 תווים לפחות');
    setBusy(true);
    setErr('');
    try {
      await store.updatePassword(pw);
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="wordmark">MODY</div>
        <h1>בחירת סיסמה חדשה</h1>
        <label htmlFor="pw1">סיסמה חדשה</label>
        <input id="pw1" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <label htmlFor="pw2">אימות סיסמה</label>
        <input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        <button className="cta" type="submit" disabled={busy}>
          שמור סיסמה
        </button>
        {err && <div className="msg err">{err}</div>}
      </form>
    </div>
  );
}
