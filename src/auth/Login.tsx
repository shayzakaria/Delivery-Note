import { useState, type FormEvent } from 'react';
import { store } from '../data/store';

type Mode = 'login' | 'signup' | 'reset';

const TITLES: Record<Mode, string> = {
  login: 'דיווח משלוחים · סולל בונה',
  signup: 'הרשמה לאתר',
  reset: 'איפוס סיסמה',
};

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('login');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function switchTo(m: Mode) {
    setMode(m);
    setMsg(null);
    setPassword('');
    setPassword2('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (mode === 'signup') {
      if (password.length < 8) return setMsg({ ok: false, text: 'יש לבחור סיסמה של 8 תווים לפחות' });
      if (password !== password2) return setMsg({ ok: false, text: 'הסיסמאות אינן זהות' });
    }
    setBusy(true);
    try {
      if (mode === 'login') await store.signIn(email, password);
      else if (mode === 'signup') {
        const { needsConfirmation } = await store.signUp(email, password);
        if (needsConfirmation) {
          setMode('login');
          setPassword('');
          setPassword2('');
          setMsg({ ok: true, text: `נשלח מייל אימות אל ${email.trim()}. יש ללחוץ על הקישור שבמייל ואז להתחבר.` });
        }
      } else {
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
        <img className="logo-auth" src="/mody-logo-light.png" alt="MODY" />
        <h1>{TITLES[mode]}</h1>
        {store.mode === 'mock' && mode === 'login' && <div className="msg ok">מצב הדגמה — ניתן להתחבר עם demo@mody.co.il וכל סיסמה.</div>}
        {mode === 'signup' && <div className="auth-note">ההרשמה פתוחה רק לכתובות שמנהל המערכת אישר מראש.</div>}
        <label htmlFor="email">אימייל</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode !== 'reset' && (
          <>
            <label htmlFor="password">{mode === 'signup' ? 'בחירת סיסמה (8 תווים לפחות)' : 'סיסמה'}</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}
        {mode === 'signup' && (
          <>
            <label htmlFor="password2">אימות סיסמה</label>
            <input id="password2" type="password" autoComplete="new-password" required value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </>
        )}
        <button className="cta" type="submit" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'כניסה' : mode === 'signup' ? 'הרשמה' : 'שלח קישור לאיפוס'}
        </button>
        {msg && <div className={'msg ' + (msg.ok ? 'ok' : 'err')}>{msg.text}</div>}
        <div className="auth-links">
          {mode === 'login' ? (
            <>
              <button type="button" className="alt" onClick={() => switchTo('signup')}>
                אין לך חשבון? הרשמה
              </button>
              <button type="button" className="alt" onClick={() => switchTo('reset')}>
                שכחתי סיסמה
              </button>
            </>
          ) : (
            <button type="button" className="alt" onClick={() => switchTo('login')}>
              חזרה לכניסה
            </button>
          )}
        </div>
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
        <img className="logo-auth" src="/mody-logo-light.png" alt="MODY" />
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
