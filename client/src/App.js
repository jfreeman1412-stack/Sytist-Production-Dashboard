import React, { useEffect, useState } from 'react';
import api from './services/api';
import LoginPage from './pages/LoginPage';

function App() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);

  // On mount, see if a previously-stored session is still valid.
  useEffect(() => {
    let cancelled = false;
    api
      .getSession()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Once logged in, ping health to confirm everything's wired.
  useEffect(() => {
    if (!user) return;
    fetch('/api/health')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setHealth)
      .catch((err) => setHealthError(err.message));
  }, [user]);

  if (checkingSession) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-primary)',
          color: 'var(--text-muted)',
          fontSize: 14,
        }}
      >
        Loading…
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }

  const handleLogout = async () => {
    await api.logout();
    setUser(null);
    setHealth(null);
    setHealthError(null);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
      }}
    >
      <header
        style={{
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-color)',
          padding: '16px 32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            Sytist Production Dashboard
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Phase 1 — auth
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13 }}>
              {user.displayName || user.username}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {user.role}
            </div>
          </div>
          <button
            className="btn btn-secondary"
            onClick={handleLogout}
            style={{ padding: '8px 16px', fontSize: 13 }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main
        style={{
          maxWidth: 800,
          margin: '32px auto',
          padding: '0 32px',
        }}
      >
        <section
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: 24,
            marginBottom: 24,
          }}
        >
          <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>Welcome back</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
            You are signed in as{' '}
            <strong>{user.displayName || user.username}</strong> with role{' '}
            <strong>{user.role}</strong>. Your session will remain active for
            24 hours.
          </p>
        </section>

        <section
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: 24,
            marginBottom: 24,
          }}
        >
          <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>Server connection</h2>
          {!health && !healthError && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Checking…</p>
          )}
          {healthError && (
            <p style={{ fontSize: 13, color: 'var(--error)' }}>
              ❌ Server not reachable: {healthError}
            </p>
          )}
          {health && (
            <>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--success)',
                  margin: '0 0 12px',
                }}
              >
                ✅ Connected to server
              </p>
              <pre
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 12,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  overflowX: 'auto',
                  margin: 0,
                }}
              >
                {JSON.stringify(health, null, 2)}
              </pre>
            </>
          )}
        </section>

        <section
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: 24,
          }}
        >
          <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>Next</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
            Phase 2 connects to the Sytist MySQL database and starts pulling
            real order data. See <code>SPEC.md</code> for the full roadmap.
          </p>
        </section>
      </main>
    </div>
  );
}

export default App;
