import React, { useEffect, useState } from 'react';
import api from './services/api';
import LoginPage from './pages/LoginPage';

function App() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  // Server (dashboard backend) health
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);

  // Sytist MySQL health
  const [sytistHealth, setSytistHealth] = useState(null);
  const [sytistError, setSytistError] = useState(null);
  const [checkingSytist, setCheckingSytist] = useState(false);

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

  // Once logged in, ping health endpoints.
  useEffect(() => {
    if (!user) return;

    fetch('/api/health')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setHealth)
      .catch((err) => setHealthError(err.message));

    setCheckingSytist(true);
    api
      .get('/api/sytist/health')
      .then(setSytistHealth)
      .catch((err) => setSytistError(err.message))
      .finally(() => setCheckingSytist(false));
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
    setSytistHealth(null);
    setSytistError(null);
  };

  const recheckSytist = async () => {
    setSytistError(null);
    setSytistHealth(null);
    setCheckingSytist(true);
    try {
      const result = await api.get('/api/sytist/health');
      setSytistHealth(result);
    } catch (err) {
      setSytistError(err.message);
    } finally {
      setCheckingSytist(false);
    }
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
            Phase 2a — Sytist DB connectivity
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
            <strong>{user.role}</strong>.
          </p>
        </section>

        {/* Dashboard backend health */}
        <section
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: 24,
            marginBottom: 24,
          }}
        >
          <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>
            Dashboard server
          </h2>
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
                ✅ Connected to dashboard server
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

        {/* Sytist MySQL health */}
        <section
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: 24,
            marginBottom: 24,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <h2 style={{ fontSize: 16, margin: 0 }}>Sytist database</h2>
            <button
              className="btn btn-secondary"
              onClick={recheckSytist}
              disabled={checkingSytist}
              style={{ padding: '6px 12px', fontSize: 12 }}
            >
              {checkingSytist ? 'Checking…' : 'Re-check'}
            </button>
          </div>

          {checkingSytist && !sytistHealth && !sytistError && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Checking…</p>
          )}
          {sytistError && (
            <>
              <p style={{ fontSize: 13, color: 'var(--error)', margin: '0 0 12px' }}>
                ❌ Cannot reach Sytist database
              </p>
              <pre
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 12,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--error)',
                  overflowX: 'auto',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {sytistError}
              </pre>
            </>
          )}
          {sytistHealth && (
            <>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--success)',
                  margin: '0 0 12px',
                }}
              >
                ✅ Connected to Sytist database ({sytistHealth.elapsedMs}ms)
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
                {JSON.stringify(sytistHealth, null, 2)}
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
            Phase 2b adds the order queries — fetching orders, assembling the
            canonical shape, and a test endpoint to inspect real Sytist data.
            See <code>SPEC.md</code> for details.
          </p>
        </section>
      </main>
    </div>
  );
}

export default App;
