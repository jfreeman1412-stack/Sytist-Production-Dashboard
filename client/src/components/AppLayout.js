import React from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import HomePage from '../pages/HomePage';
import OrdersListPage from '../pages/OrdersListPage';
import OrderDetailPage from '../pages/OrderDetailPage';

/**
 * App shell shown to authenticated users.
 *
 * Header: brand + nav links + user identity / logout.
 * Main:   the matched route's page.
 *
 * Phase 3a: just routing scaffolding. Pages are mostly empty.
 */
export default function AppLayout({ user, onLogout }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Header user={user} onLogout={onLogout} />

      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/orders" element={<OrdersListPage />} />
          <Route path="/orders/:orderId" element={<OrderDetailPage />} />
          {/* Unknown paths fall back to home. Could be a 404 page later. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Header({ user, onLogout }) {
  const navLinkStyle = ({ isActive }) => ({
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: 13,
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    background: isActive ? 'var(--bg-input)' : 'transparent',
    textDecoration: 'none',
    fontWeight: isActive ? 600 : 500,
  });

  return (
    <header
      style={{
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-color)',
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <NavLink
          to="/"
          style={{
            fontSize: 16,
            fontWeight: 600,
            textDecoration: 'none',
            color: 'var(--text-primary)',
          }}
        >
          Sytist Dashboard
        </NavLink>

        <nav style={{ display: 'flex', gap: 4 }}>
          <NavLink to="/orders" style={navLinkStyle}>
            Orders
          </NavLink>
        </nav>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13 }}>{user.displayName || user.username}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{user.role}</div>
        </div>
        <button
          className="btn btn-secondary"
          onClick={onLogout}
          style={{ padding: '6px 12px', fontSize: 12 }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
