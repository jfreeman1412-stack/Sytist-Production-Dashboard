import React, { useEffect, useState } from 'react';
import api from './services/api';
import LoginPage from './pages/LoginPage';
import AppLayout from './components/AppLayout';

/**
 * Top-level component. Handles auth gate; once logged in, hands off to
 * AppLayout which renders the header, nav, and routed pages.
 */
function App() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

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

  const handleLogout = async () => {
    await api.logout();
    setUser(null);
  };

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

  return <AppLayout user={user} onLogout={handleLogout} onUserUpdate={setUser} />;
}

export default App;
