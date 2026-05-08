import React, { useState } from 'react';
import api from '../services/api';

export default function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Username and password required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await api.login(username, password);
      onLogin(result.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)',
      }}
    >
      <div
        style={{
          width: 380,
          padding: 40,
          background: 'var(--bg-card)',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-light)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
              fontSize: 24,
              fontWeight: 700,
              color: '#fff',
            }}
          >
            SL
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px' }}>
            Sportsline Photography
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
            Sytist Production Dashboard
          </p>
        </div>

        {/* Error */}
        {error && (
          <div
            style={{
              padding: '10px 14px',
              marginBottom: 20,
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(220,53,69,0.1)',
              border: '1px solid rgba(220,53,69,0.3)',
              color: '#DC3545',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {/* Form */}
        <div>
          <div className="form-group">
            <label className="form-label">Username</label>
            <input
              className="form-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit(e)}
              placeholder="Enter username"
              autoFocus
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              className="form-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit(e)}
              placeholder="Enter password"
              autoComplete="current-password"
            />
          </div>

          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={loading}
            style={{ width: '100%', padding: '12px', marginTop: 8, fontSize: 14 }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </div>

        <div
          style={{
            textAlign: 'center',
            marginTop: 24,
            fontSize: 11,
            color: 'var(--text-muted)',
          }}
        >
          v0.1 — Phase 1
        </div>
      </div>
    </div>
  );
}
