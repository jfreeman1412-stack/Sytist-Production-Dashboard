import React, { useEffect, useState } from 'react';

function App() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setHealth)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Sytist Production Dashboard</h1>
        <p className="subtitle">Phase 0 — bootstrap</p>
      </header>

      <main className="app-main">
        <section className="status-card">
          <h2>Server connection</h2>
          {!health && !error && <p>Checking…</p>}
          {error && (
            <p className="status-error">
              ❌ Server not reachable: {error}
              <br />
              <small>Make sure the server is running on port 3011.</small>
            </p>
          )}
          {health && (
            <div className="status-ok">
              <p>✅ Connected to server</p>
              <pre>{JSON.stringify(health, null, 2)}</pre>
            </div>
          )}
        </section>

        <section className="next-steps">
          <h2>Next</h2>
          <p>
            Phase 1 adds login + auth. See <code>SPEC.md</code> for the full roadmap.
          </p>
        </section>
      </main>
    </div>
  );
}

export default App;
