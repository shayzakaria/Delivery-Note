import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { store } from '../data/store';
import type { Role, SessionUser } from '../data/types';
import { Login, SetNewPassword } from './Login';

type State =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  | { phase: 'recovery'; user: SessionUser | null }
  | { phase: 'no-access'; user: SessionUser }
  | { phase: 'error'; user: SessionUser; message: string }
  | { phase: 'ready'; user: SessionUser; role: Role };

export function AuthGate({ children }: { children: (user: SessionUser, role: Role) => ReactNode }) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const resolve = useCallback(async (user: SessionUser | null) => {
    if (!user) {
      setState({ phase: 'signed-out' });
      return;
    }
    try {
      const role = await store.memberRole();
      setState(role ? { phase: 'ready', user, role } : { phase: 'no-access', user });
    } catch (e) {
      setState({ phase: 'error', user, message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let active = true;
    // A password-recovery link lands with type=recovery in the URL hash.
    const recovering = /type=recovery/.test(window.location.hash);
    if (recovering) setState({ phase: 'recovery', user: null });
    else
      void store.getUser().then((u) => {
        if (active) void resolve(u);
      });
    const off = store.onAuthChange((event, user) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY') setState({ phase: 'recovery', user });
      else if (event === 'SIGNED_OUT') setState({ phase: 'signed-out' });
      else if (event === 'SIGNED_IN') {
        const s = stateRef.current;
        if (s.phase === 'recovery') return;
        if (s.phase === 'ready' && s.user.id === user?.id) return; // same session re-announced
        setState({ phase: 'loading' });
        void resolve(user);
      }
    });
    return () => {
      active = false;
      off();
    };
  }, [resolve]);

  switch (state.phase) {
    case 'loading':
      return <div className="center-screen">טוען…</div>;
    case 'signed-out':
      return <Login />;
    case 'recovery':
      return (
        <SetNewPassword
          onDone={async () => {
            history.replaceState(null, '', window.location.pathname);
            await resolve(await store.getUser());
          }}
        />
      );
    case 'no-access':
    case 'error':
      return (
        <div className="auth-page">
          <div className="auth-card">
            <img className="logo-auth" src="/mody-logo-light.png" alt="MODY" />
            <h1>{state.phase === 'no-access' ? 'אין הרשאת גישה' : 'שגיאה בטעינה'}</h1>
            <p style={{ fontSize: 13, color: '#444', lineHeight: 1.7 }}>
              {state.phase === 'no-access' ? (
                <>
                  המשתמש <b dir="ltr">{state.user.email}</b> מחובר, אך אינו מורשה להשתמש במערכת.
                  <br />
                  יש לפנות למנהל המערכת כדי שיוסיף אותו לרשימת המשתמשים.
                </>
              ) : (
                state.message
              )}
            </p>
            {state.phase === 'error' && (
              <button className="cta" onClick={() => resolve(state.user)}>
                נסה שוב
              </button>
            )}
            <button className="alt" onClick={() => store.signOut()}>
              התנתק
            </button>
          </div>
        </div>
      );
    case 'ready':
      return <>{children(state.user, state.role)}</>;
  }
}
